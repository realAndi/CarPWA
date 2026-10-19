// Messages between CarPWA apps on the "carpwa.examples" channel. The dashboard
// publishes a heartbeat every 30 s and shows the latest message other apps
// (or the simulator's channel panel) sent. Channels need no permission.

import { $, setText, explain, requireServer, ago } from '../lib/util.js';

const CHANNEL = 'carpwa.examples';
const HEARTBEAT_MS = 30000;

function describe(data) {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    if (typeof data.text === 'string') return data.text;
    if (data.type === 'heartbeat') return `Heartbeat${typeof data.app === 'string' ? ` from ${data.app}` : ''}`;
  }
  return JSON.stringify(data);
}

function sender(from) {
  if (from === 'dev') return 'the developer';
  if (from === 'native') return 'CarPWA';
  return String(from).split('.').pop(); // com.carpwa.example.hello → hello
}

const listening = (n) => (n ? `Heard by ${n} other app${n === 1 ? '' : 's'}` : 'No other apps listening');

export function mountChannel() {
  const channel = CarPWA.channel(CHANNEL);
  let latest = null;   // { from, data, at }
  let reach = '';      // result of our last publish

  function render() {
    setText('channel-text', latest ? describe(latest.data) : 'No messages yet');
    setText('channel-line', latest ? `From ${sender(latest.from)} · ${ago(latest.at)}` : reach);
  }

  async function publish(data, done) {
    try {
      requireServer();
      reach = done(await channel.publish(data));
      setText('channel-note', '');
    } catch (e) {
      reach = '';
      setText('channel-note', explain(e, { EUNAVAILABLE: 'Messages need the CarPWA server' }));
    }
    render();
  }

  channel.subscribe((data, message) => {
    latest = { from: message.from, data, at: Date.now() };
    render();
  });

  $('wave').addEventListener('click', () => {
    publish({ type: 'wave', text: 'Hello from the Dashboard', at: Date.now() }, (n) => `Waved · ${listening(n).toLowerCase()}`);
  });

  const heartbeat = () => publish({ type: 'heartbeat', app: 'Dashboard', at: Date.now() }, listening);
  render();
  heartbeat();
  setInterval(heartbeat, HEARTBEAT_MS); // also refreshes the "min ago" label
}
