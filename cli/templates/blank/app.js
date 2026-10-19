// {{NAME}}: shows which car you are connected to, whether it is in night mode,
// and the size of the screen your app gets. Every value updates live.

const $ = (id) => document.getElementById(id);

function renderCar(state) {
  if (!state) return;
  $('night').textContent = state.nightMode ? 'On' : 'Off';
  $('night-icon').textContent = state.nightMode ? '☾' : '☀︎';
  $('appearance').textContent = `appearance ${state.appearance}${state.limitedUI ? ' · driving' : ''}`;
}

function renderScreen(screen) {
  if (!screen) return;
  $('size').textContent = `${screen.width} × ${screen.height}`;
  $('input').textContent = `${screen.interaction.primary} input · ${screen.scale}× scale`;
}

async function main() {
  const env = await CarPWA.ready();
  $('mode').textContent = env.mode;

  if (env.mode === 'browser') {
    $('car').textContent = 'No car connected';
    $('hint').hidden = false;
    return;
  }

  try {
    const info = await CarPWA.car.getInfo();
    $('car').textContent = info.connected
      ? `Connected to ${info.name || [info.manufacturer, info.model].filter(Boolean).join(' ') || 'your car'}`
      : 'Car disconnected';
  } catch (err) {
    $('car').textContent = `Car info unavailable (${err.code})`;
  }

  // CarPWA.car.state / CarPWA.screen.info are cached by the SDK; fetch them if
  // the host did not provide an initial state.
  renderCar(CarPWA.car.state || await CarPWA.car.getState());
  renderScreen(CarPWA.screen.info || await CarPWA.screen.getInfo());

  CarPWA.car.on('state', (event) => renderCar(event.state));
  CarPWA.car.on('connect', (info) => { $('car').textContent = `Connected to ${info.name || 'your car'}`; });
  CarPWA.car.on('disconnect', () => { $('car').textContent = 'Car disconnected'; });
  CarPWA.screen.on('change', renderScreen);
}

main().catch((err) => console.error('startup failed', err));
