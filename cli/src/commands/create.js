import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { parseArgs } from '../args.js';
import { ID_RE, validateApp, printReport } from '../manifest.js';
import { drawIcon, ICON_THEMES } from '../png.js';
import { CLI_ROOT } from '../sdk.js';
import { c, CliError, ok } from '../log.js';

const TEMPLATES = {
  blank: { summary: 'car name, night mode and screen info', permissions: [] },
  media: { summary: 'now playing with transport controls and knob focus', permissions: ['media', 'media.control'] },
  dashboard: { summary: 'clock, now playing and a storage-backed setting', permissions: ['media'] },
};

export const help = `Usage: carpwa create <dir> [options]

Scaffolds a new CarPWA app: carpwa.json, index.html, app.js, style.css and a
generated icon.png.

Options:
  --id <id>            app id, reverse-DNS (default com.example.<dir name>)
  --name <name>        display name (default: the folder name, title-cased)
  --template <name>    ${Object.entries(TEMPLATES).map(([k, t]) => `${k} (${t.summary})`).join('\n                       ')}
                       default: blank
  --force              write into a folder that is not empty`;

export async function run(argv) {
  const { opts, positionals } = parseArgs(argv, {
    id: { type: 'string' },
    name: { type: 'string' },
    template: { type: 'string', alias: 't', default: 'blank' },
    force: { type: 'boolean' },
  });
  const target = positionals[0];
  if (!target) throw new CliError('carpwa create needs a folder name, e.g. `carpwa create my-app`');
  const template = TEMPLATES[opts.template];
  if (!template) throw new CliError(`unknown template "${opts.template}"; pick one of ${Object.keys(TEMPLATES).join(', ')}`);

  const dir = resolve(target);
  const slug = basename(dir);
  const name = (opts.name || titleCase(slug)).trim();
  if (!name) throw new CliError('--name must not be empty');
  const id = opts.id || `com.example.${slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'app'}`;
  if (!ID_RE.test(id) || /^\.+$/.test(id)) {
    throw new CliError(`invalid id "${id}": use letters, digits, "." and "-" only, at most 128 characters (e.g. com.you.app)`);
  }

  if (existsSync(dir)) {
    const entries = readdirSync(dir).filter((f) => !f.startsWith('.'));
    if (entries.length && !opts.force) {
      throw new CliError(`${relative(process.cwd(), dir) || '.'} is not empty; pick another folder or pass --force`);
    }
  }
  mkdirSync(dir, { recursive: true });

  const manifest = {
    id,
    name,
    short_name: shortName(name),
    version: '1.0.0',
    start_url: 'index.html',
    icon: 'icon.png',
    background_color: '#000000',
    permissions: template.permissions,
  };
  const written = [];
  const write = (file, content) => {
    writeFileSync(join(dir, file), content);
    written.push(file);
  };

  write('carpwa.json', JSON.stringify(manifest, null, 2) + '\n');
  const tdir = join(CLI_ROOT, 'templates', opts.template);
  for (const file of readdirSync(tdir)) {
    const text = readFileSync(join(tdir, file), 'utf8')
      .split('{{NAME}}').join(file.endsWith('.html') ? escapeHTML(name) : name)
      .split('{{ID}}').join(id);
    write(file, text);
  }
  write('icon.png', drawIcon(ICON_THEMES[opts.template]));
  write('README.md', readme({ name, id, template: opts.template, permissions: template.permissions }));

  const result = validateApp(dir);
  if (result.errors.length) {
    printReport(result);
    throw new CliError('the generated app did not validate; this is a bug in carpwa create');
  }

  const rel = relative(process.cwd(), dir) || '.';
  ok(`Created ${c.bold(name)} ${c.dim(`(${id}, ${opts.template} template)`)} in ${rel}/`);
  for (const f of written) console.log(`  ${c.dim('+')} ${f}`);
  console.log('');
  console.log('Next:');
  if (rel !== '.') console.log(`  ${c.cyan(`cd ${rel.includes(' ') ? JSON.stringify(rel) : rel}`)}`);
  console.log(`  ${c.cyan('carpwa sim --open')}     ${c.dim('# run it in the desktop simulator')}`);
  console.log(`  ${c.cyan('carpwa dev')}            ${c.dim('# push to the phone with live reload')}`);
  return 0;
}

function readme({ name, id, template, permissions }) {
  return `# ${name}

A CarPWA app (\`${id}\`) made from the \`${template}\` template. It runs full-screen
on the CarPlay screen of a jailbroken iPhone with CarPWA installed.

## Run it

\`\`\`sh
carpwa sim --open   # desktop CarPlay simulator with a mock car
carpwa dev          # push to the phone, reload on save, page console in your terminal
\`\`\`

\`carpwa dev\` reaches the phone over SSH (\`--host <ssh host>\`, default
\`$CARPWA_HOST\`, else \`iphone\`). Run \`carpwa doctor\` if it cannot connect.

## Files

| file | what |
|---|---|
| \`carpwa.json\` | the manifest: id, name, icon${permissions.length ? `, permissions (${permissions.join(', ')})` : ', permissions'} |
| \`index.html\`, \`app.js\`, \`style.css\` | the app; the SDK is served at \`/_carpwa/sdk.js\` |
| \`icon.png\` | the CarPlay icon, square; CarPlay rounds the corners itself |

More: \`carpwa validate\`, \`carpwa push\`, \`carpwa package\` (builds a .deb).
`;
}

function titleCase(slug) {
  return slug
    .replace(/[-_.]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || 'My App';
}

// CarPlay truncates labels past ~12 characters; keep the first word(s) that fit.
function shortName(name) {
  if ([...name].length <= 12) return name;
  let out = '';
  for (const word of name.split(/\s+/)) {
    const next = out ? `${out} ${word}` : word;
    if ([...next].length > 12) break;
    out = next;
  }
  return out || [...name].slice(0, 12).join('');
}

function escapeHTML(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
