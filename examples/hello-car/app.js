// Hello Car: the smallest useful CarPWA app. It reads the car and the screen,
// follows the car's live state, and talks back with a banner. No permissions.

const $ = (id) => document.getElementById(id);

const MODES = { carplay: 'On CarPlay', simulator: 'In the CarPWA simulator', browser: 'In a web browser' };
const TRANSPORTS = { wired: 'USB cable', wireless: 'Wireless', unknown: 'Unknown' };
const INPUTS = { touch: 'Touchscreen', knob: 'Knob', touchpad: 'Touchpad', unknown: 'Unknown' };

// Every SDK promise can reject with a CarPWAError; say what happened, calmly.
function explain(e) {
  switch (e && e.code) {
    case 'ENOTCAR': return 'Not on CarPlay. Open this app on the car screen or in carpwa sim.';
    case 'EUNAVAILABLE': return 'The car is not available right now.';
    case 'ETIMEOUT': return 'The car did not answer. Try again.';
    case 'EPERM': return 'This app is not allowed to do that.';
    default: return (e && e.message) || 'Something went wrong.';
  }
}

const say = (text) => { $('status').textContent = text; };
const fail = (e) => say(explain(e));

function showInfo(info) {
  $('car-name').textContent = info.name || 'car';
  $('car-make').textContent =
    [info.manufacturer, info.model].filter(Boolean).join(' · ') || 'Make and model not shared';
  $('transport').textContent = TRANSPORTS[info.transport] || TRANSPORTS.unknown;
}

function showScreen(screen) {
  $('screen-size').textContent = `${screen.width} × ${screen.height}`;
  $('screen-scale').textContent = `@${screen.scale}x`;
  $('input').textContent = INPUTS[screen.interaction.primary] || INPUTS.unknown;
}

function badge(id, on, value) {
  $(id).dataset.on = String(on);
  $(id).querySelector('b').textContent = value;
}

// car.getState() returns everything; the nightMode / appearance / limitedUI
// events carry only the field that changed, so merge them into one object.
const live = {};
function showState(change) {
  Object.assign(live, change);
  badge('night', !!live.nightMode, live.nightMode ? 'On' : 'Off');
  badge('appearance', false, live.appearance === 'light' ? 'Light' : 'Dark');
  badge('limited', !!live.limitedUI, live.limitedUI ? 'On' : 'Off');
}

await CarPWA.ready();
$('mode').textContent = MODES[CarPWA.env.mode] || 'CarPWA';

CarPWA.car.getInfo().then(showInfo, (e) => {
  $('car-make').textContent = 'No car connected';
  fail(e);
});
CarPWA.screen.getInfo().then(showScreen, fail);
CarPWA.car.getState().then(showState, fail);

CarPWA.car.on('nightMode', showState);
CarPWA.car.on('appearance', showState);
CarPWA.car.on('limitedUI', showState);
CarPWA.car.on('connect', (info) => { showInfo(info); say(''); });
CarPWA.car.on('disconnect', () => say('The car disconnected.'));
CarPWA.screen.on('change', showScreen);

$('banner').addEventListener('click', () => {
  CarPWA.ui.banner({ title: 'Hello from the web', subtitle: `Running in ${$('car-name').textContent}` })
    .then(() => say(''), fail);
});

// ui.close() goes back to the CarPlay home screen; the page keeps running.
$('close').addEventListener('click', () => {
  CarPWA.ui.close().catch(fail);
});

// Knob and touchpad cars: rotating moves between the buttons, pressing clicks.
// Start with a highlighted button only where the knob is the main input.
const knobFirst = ['knob', 'touchpad'].includes(CarPWA.screen.info?.interaction.primary);
CarPWA.focus.enable({ initial: knobFirst ? '#banner' : false });
