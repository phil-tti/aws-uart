load('api_config.js');
load('api_gpio.js');
load('api_mqtt.js');
load('api_sys.js');
load('api_timer.js');
load('api_uart.js');
load('api_rpc.js');
load('api_aws.js');
load('api_net.js');

let uartNo = 0; // 1 for only debugging, no input
let led = 2;
let LED_OFF = 0;
let LED_ON = 1;
let relay = 5; // D1 on NodeMCU
let reset = 4; // D2 on NodeMCU
let isConnected = false;
let isMQTTConnected = false;

let deviceId = Cfg.get('device.id');
let metaTopic = 'devices/' + deviceId + '/meta';
let topic = 'mos/'+ deviceId;
let ct = 'mcu/'+deviceId+'/control';

GPIO.set_mode(relay, GPIO.MODE_OUTPUT);
GPIO.set_mode(reset, GPIO.MODE_OUTPUT);
GPIO.set_mode(led, GPIO.MODE_OUTPUT);

GPIO.write(led,0); // Turn on default blue led on esp8266
GPIO.write(relay,0); // Turn off GPIO5 which is connected to relay
GPIO.write(reset,1); // Turn off GPIO4 which is connected to MCU

/* UART Config */
UART.setConfig(uartNo,{
  baudRate: 115200,
  rxBufSize: 1024,
  txBufSize: 1024,
});

/* Initial state setup which will be checked with AWS IoT shadow and
the delta will be updated. */
let state = {
  led: GPIO.read(0),
  p4: GPIO.read(4),
  p5: GPIO.read(5)
};

/* ESP module meta info and the state data. */
let getInfo = function() {
  return JSON.stringify({
    deviceId: deviceId,
    total_ram: Sys.total_ram(),
    free_ram: Sys.free_ram(),
    uptime: Sys.uptime(),
    state: state,
    t: Timer.now()
  });
};

Net.setStatusEventHandler(function(ev, arg){
  print("WiFi Event:",ev);
  if(ev === Net.STATUS_DISCONNECTED) {
    print("WiFi DISCONNECTED");
    isConnected = false;
  }
  if(ev === Net.STATUS_CONNECTING) {
    print("WiFi CONNECTING");
    isConnected = false;
  }
  if(ev === Net.STATUS_CONNECTED) {
    print("WiFi CONNECTED");
    isConnected = true;
  }
  if(ev === Net.STATUS_GOT_IP) {
    print("Device got IP");
    isConnected = true;
  }
},null);

MQTT.setEventHandler(function(conn,ev,evdata){
  // MG_EV_MQTT_CONNACK
  if( ev === MQTT.EV_CONNACK ) {
    isMQTTConnected = true;
    bu();
    print("MQTT Connection Acknowledge:", JSON.stringify(ev));
  }
  // MG_EV_MQTT_DISCONNECT
  if( ev === 214 ) {
    isMQTTConnected = false;
    print("MQTT DisConnection:", JSON.stringify(ev));
  }
},null);
/*
The meat dispacther!! When the available buffer at UART 0 is greater 200bytes,
we will send this data to the MQTT topic. In additon we also turn off the blue
led (default one) whenever the data is available and being sent.
*/
function bu(){
  UART.setDispatcher(uartNo, function(uartNo, ud) {
    // print("UART dispacther - uart:",uartNo);
    let ra = UART.readAvail(uartNo);
    let oa = UART.writeAvail(uartNo);
    if ( ra > 200 ) { // read buffer > 200 bytes
      let data = UART.read(uartNo);
      print("Received UART data:", data);
      let res = MQTT.pub(topic, JSON.stringify({ "data": data }), 1);
      if(res){
        GPIO.write(led,1);
      } else {
        GPIO.write(led,0);
      }
      print('Published: ', res ? 'yes' : 'no', 'Response',res);
    }
  }, null);

  UART.setRxEnabled(uartNo, true);
}

/* Updating pins and led based on the state */
function updateLed() {
  GPIO.write(led, state.led ? LED_OFF : LED_ON);
  GPIO.write(relay, state.p5 ? LED_ON : LED_OFF);
  GPIO.write(reset, state.p4 ? LED_ON : LED_OFF);
}

/* Updating state based on the desired state by AWS */
function updateState(newSt) {
  if (newSt.led !== undefined) {
    state.led = newSt.led;
  }
  if (newSt.p4 !== undefined) {
    state.p4 = newSt.p4;
  }
  if (newSt.p5 !== undefined) {
    state.p5 = newSt.p5;
  }
}

/* Reporting the current state to AWS */
function reportState() {
  print('Reporting state:', JSON.stringify(state));
  AWS.Shadow.update(0, {
    reported: state,
  });
}

updateLed();

/* AWS Shadow logic */
AWS.Shadow.setStateHandler(function(ud, ev, reported, desired, reported_md, desired_md) {
  print('Event:', ev, '('+AWS.Shadow.eventName(ev)+')');
  if (ev === AWS.Shadow.CONNECTED) {
    reportState();
    return;
  }

  if (ev !== AWS.Shadow.GET_ACCEPTED && ev !== AWS.Shadow.UPDATE_DELTA) {
    return;
  }

  print('Reported state:', JSON.stringify(reported));
  print('Desired state :', JSON.stringify(desired));

  updateState(reported);
  updateState(desired);
  updateLed();

  print('New state:', JSON.stringify(state));

  if (ev === AWS.Shadow.UPDATE_DELTA) {
    reportState();
  }
}, null);

MQTT.sub(ct, function(conn, topic, msg) {
  let m = JSON.parse(msg);
  print('Topic:', topic, 'message:', msg, "Reset:",m.reset,"Relay:",m.relay);

  if(m.reset === "1") {
    GPIO.write(reset,0);
  }
  if (m.reset === "0") {
    GPIO.write(reset,1);
  }
  if(m.relay === "1") {
    GPIO.write(relay,1);
  }
  if (m.relay === "0") {
    GPIO.write(relay,0);
  }

}, null);
/* Send ESP device meta to MQTT topic every second */
Timer.set(10*1000 /* 1 sec */, true /* repeat */, function() {
  let message = getInfo();

  if(isConnected) {
    if(isMQTTConnected){
      let ok = MQTT.pub(metaTopic, message, 1, false);
      print('Published:', ok ? 'yes' : 'no', 'topic:', metaTopic, 'message:', message);
    }
  } else {
    print('Device not connected - message:', message);
  }
}, null);
