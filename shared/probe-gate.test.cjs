/**
 * probe-gate.test.cjs — validateProbeCommand() regression coverage.
 *
 * The raw-PTY diagnosis path (planning's capability.probe through a visible
 * terminal) must enforce the same read-only contract as the spawn-based
 * capabilityProbe — plus metacharacter rejection since it runs under a shell.
 *
 * Run: node shared/probe-gate.test.cjs
 */

const { validateProbeCommand } = require('./capability-index.cjs');

let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) { pass++; console.log(`  PASS: ${name}`); }
  else { fail++; console.log(`  FAIL: ${name}`); }
}

// ── Allowed — read-only verb contract ────────────────────────────────────────
t('gh --help', validateProbeCommand('gh --help').ok === true);
t('gh -h', validateProbeCommand('gh -h').ok === true);
t('gh version', validateProbeCommand('gh version').ok === true);
t('gh --version', validateProbeCommand('gh --version').ok === true);
t('gh auth status', validateProbeCommand('gh auth status').ok === true);
t('gh auth list', validateProbeCommand('gh auth list').ok === true);
t('aws sts get-caller-identity → verb denied', validateProbeCommand('aws sts get-caller-identity').ok === false);
t('vercel whoami', validateProbeCommand('vercel whoami').ok === true);
t('docker … denied as tool', validateProbeCommand('docker ps').ok === false);
t('cast status', validateProbeCommand('cast status').ok === true);
t('tool config list', validateProbeCommand('mycli config list').ok === true);
t('tool config get', validateProbeCommand('mycli config get').ok === true);
t('tool doctor', validateProbeCommand('mycli doctor').ok === true);
t('bare tool → --help default', validateProbeCommand('mycli').ok === true);

// ── Denied — mutating verbs ──────────────────────────────────────────────────
t('run denied', validateProbeCommand('mycli run job').ok === false);
t('exec denied', validateProbeCommand('mycli exec ls').ok === false);
t('install denied', validateProbeCommand('mycli install pkg').ok === false);
t('login denied', validateProbeCommand('mycli login').ok === false);
t('create denied', validateProbeCommand('mycli create x').ok === false);
t('auth login denied (second token)', validateProbeCommand('gh auth login').ok === false);
t('config set denied (second token)', validateProbeCommand('mycli config set k v').ok === false);
t('write denied', validateProbeCommand('mycli write f').ok === false);
t('send denied', validateProbeCommand('mycli send msg').ok === false);
t('delete denied', validateProbeCommand('mycli delete f').ok === false);

// ── Denied — dangerous tools as first token ──────────────────────────────────
t('sudo denied', validateProbeCommand('sudo ls').ok === false);
t('bash denied', validateProbeCommand('bash -c ls').ok === false);
t('node denied', validateProbeCommand('node -e x').ok === false);
t('python3 denied', validateProbeCommand('python3 -c x').ok === false);
t('npx denied', validateProbeCommand('npx server --help').ok === false);
t('curl denied', validateProbeCommand('curl https://x').ok === false);
t('ssh denied', validateProbeCommand('ssh host status').ok === false);
t('osascript denied', validateProbeCommand('osascript -e x').ok === false);

// ── Denied — shell metacharacters (raw PTY path runs a real shell) ───────────
t('semicolon chain denied', validateProbeCommand('mycli --help; rm -rf /').ok === false);
t('pipe denied', validateProbeCommand('mycli status | tee /tmp/x').ok === false);
t('redirect denied', validateProbeCommand('mycli status > /tmp/x').ok === false);
t('backtick denied', validateProbeCommand('mycli `whoami`').ok === false);
t('$() denied', validateProbeCommand('mycli $(id)').ok === false);
t('&& denied', validateProbeCommand('mycli status && rm x').ok === false);
t('glob denied', validateProbeCommand('mycli list *.key').ok === false);

// ── Denied — flag-shaped payloads ────────────────────────────────────────────
t('--output denied', validateProbeCommand('mycli list --output /tmp/x').ok === false);
t('-c denied', validateProbeCommand('mycli -c "rm x"').ok === false);
t('--exec denied', validateProbeCommand('mycli --exec x').ok === false);
t('--config denied', validateProbeCommand('mycli --config /tmp/evil').ok === false);

// ── Denied — malformed ───────────────────────────────────────────────────────
t('empty denied', validateProbeCommand('').ok === false);
t('whitespace denied', validateProbeCommand('   ').ok === false);
t('null denied', validateProbeCommand(null).ok === false);
t('bad tool name denied', validateProbeCommand('../evil --help').ok === false);
t('tool with slash denied', validateProbeCommand('/bin/sh --help').ok === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
