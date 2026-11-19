// Discord: Rich Presence over the local Discord client's IPC pipe (no login or token needed), and
// optional channel messages through a webhook URL.
import net from 'node:net';

type Activity = Record<string, unknown> | null;

export class DiscordPresence {
  status = 'off';
  private sock: net.Socket | null = null;
  private ready = false;
  private clientId = '';
  private want: Activity = null;
  private sentKey = '';
  private timer: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private buf = Buffer.alloc(0);

  /** Turns presence on/off or switches application IDs. */
  configure(enabled: boolean, clientId: string) {
    clientId = clientId.trim();
    if (!enabled || !/^\d{5,}$/.test(clientId)) {
      this.close();
      this.clientId = '';
      this.status = enabled ? 'needs a valid Application ID' : 'off';
      return;
    }
    if (clientId === this.clientId && (this.sock || this.retry)) return;
    this.close();
    this.clientId = clientId;
    this.connect(0);
  }

  private connect(i: number) {
    if (!this.clientId) return;
    this.status = 'looking for Discord…';
    const s = net.createConnection(`\\\\?\\pipe\\discord-ipc-${i}`);
    s.once('error', () => {
      s.destroy();
      if (i < 9) this.connect(i + 1);
      else { this.status = 'Discord is not running (retrying)'; this.retry = setTimeout(() => { this.retry = null; this.connect(0); }, 15000); }
    });
    s.once('connect', () => {
      this.sock = s; this.buf = Buffer.alloc(0);
      s.removeAllListeners('error');
      s.on('error', () => { /* close follows */ });
      s.on('data', (d) => this.onData(Buffer.isBuffer(d) ? d : Buffer.from(d)));
      s.on('close', () => {
        if (this.sock !== s) return;
        this.sock = null; this.ready = false; this.sentKey = '';
        if (this.clientId) { this.status = 'Discord closed (retrying)'; this.retry = setTimeout(() => { this.retry = null; this.connect(0); }, 15000); }
      });
      this.send(0, { v: 1, client_id: this.clientId });
    });
  }

  private send(op: number, payload: unknown) {
    if (!this.sock) return;
    const json = Buffer.from(JSON.stringify(payload));
    const head = Buffer.alloc(8);
    head.writeUInt32LE(op, 0); head.writeUInt32LE(json.length, 4);
    this.sock.write(Buffer.concat([head, json]));
  }

  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 8) {
      const op = this.buf.readUInt32LE(0), len = this.buf.readUInt32LE(4);
      if (this.buf.length < 8 + len) break;
      let msg: any = {};
      try { msg = JSON.parse(this.buf.subarray(8, 8 + len).toString('utf8')); } catch { /* ignore */ }
      this.buf = this.buf.subarray(8 + len);
      if (op === 1 && msg.evt === 'READY') {
        this.ready = true;
        this.status = `connected (${msg.data?.user?.username ?? 'Discord'})`;
        this.sentKey = ''; this.flush();
      } else if (op === 1 && msg.evt === 'ERROR') {
        this.status = `Discord error: ${msg.data?.message ?? 'unknown'}`;
      } else if (op === 2) {
        this.status = `Discord refused: ${msg.message ?? 'check the Application ID'}`;
        const id = this.clientId; this.close(); this.clientId = id;
      } else if (op === 3) {
        this.send(4, msg); // ping → pong
      }
    }
  }

  /** Queues an activity (null clears it). Updates are batched to respect Discord's rate limit. */
  set(activity: Activity) {
    this.want = activity;
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 1500);
  }

  private flush() {
    if (!this.ready) return;
    const key = JSON.stringify(this.want);
    if (key === this.sentKey) return;
    this.sentKey = key;
    this.send(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: this.want ?? undefined }, nonce: `${Date.now()}-${Math.random()}` });
  }

  close() {
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    const s = this.sock; this.sock = null; this.ready = false; this.sentKey = '';
    if (s) { try { s.destroy(); } catch { /* ignore */ } }
  }
}

/** Builds a Discord activity, dropping empty fields (Discord rejects text shorter than 2 characters). */
export function buildActivity(p: { details: string; state: string; start: number | null; largeImage: string; largeText: string; buttonLabel: string; buttonUrl: string }) {
  const t = (s: string) => (s && s.trim().length >= 2 ? s.trim().slice(0, 128) : undefined);
  const a: Record<string, unknown> = { details: t(p.details), state: t(p.state), instance: false };
  if (p.start) a.timestamps = { start: p.start };
  if (p.largeImage) a.assets = { large_image: p.largeImage, large_text: t(p.largeText) };
  if (t(p.buttonLabel) && /^https?:\/\//.test(p.buttonUrl)) a.buttons = [{ label: p.buttonLabel.slice(0, 32), url: p.buttonUrl }];
  return a;
}

export async function postWebhook(url: string, username: string, content: string) {
  if (!/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(url)) throw new Error('That is not a Discord webhook URL.');
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: content.slice(0, 2000), username: username || undefined, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`Discord webhook replied ${r.status}`);
}
