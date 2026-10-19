// One location feed for every widget: a first fix from getCurrent(), then
// live updates from watch(). Subscribers get { fix, error } on every change.

const listeners = new Set();
let state = { fix: null, error: null };

function emit(patch) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn(state));
}

export function onLocation(fn) {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

export async function startLocation() {
  try {
    emit({ fix: await CarPWA.location.getCurrent(), error: null });
  } catch (e) {
    emit({ error: e });
    // Without the permission, or outside CarPlay, watching fails the same way.
    if (e.code === 'EPERM' || e.code === 'ENOTCAR') return;
  }
  // watch() is an event subscription: failures to start it only reach the
  // console, so the getCurrent() above is what surfaces permission problems.
  CarPWA.location.watch((fix) => emit({ fix, error: null }));
  CarPWA.location.on('error', (error) => emit({ error }));
}
