// Picture sources. Both are read-only: neither touches the game process.
//  - WindowCapture: Windows Graphics Capture through the small wgc-capture helper (like OBS window capture).
//  - ObsCapture: asks OBS (WebSocket v5) for a screenshot of the source you already show on stream.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';

export interface Source { grab(width: number): Promise<Buffer>; close(): void; readonly name: string }

export class WindowCapture implements Source {
  readonly name = 'game window';
  private proc: ChildProcessWithoutNullStreams | null = null;
  private waiting: { resolve: (b: Buffer) => void; reject: (e: Error) => void }[] = [];

  constructor(private exe: string, private processName: string) {}

  private start() {
    const p = spawn(this.exe, ['--process', this.processName], { windowsHide: true });
    this.proc = p;
    createInterface({ input: p.stdout }).on('line', (line) => {
      const w = this.waiting.shift();
      if (!w) return;
      if (line.startsWith('OK ')) w.resolve(Buffer.from(line.slice(3), 'base64'));
      else w.reject(new Error(line.replace(/^ERR /, '')));
    });
    p.stderr.on('data', () => { /* ignore */ });
    p.on('exit', () => {
      if (this.proc === p) this.proc = null;
      for (const w of this.waiting.splice(0)) w.reject(new Error('capture helper stopped'));
    });
  }

  grab(width: number): Promise<Buffer> {
    if (!this.proc) this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('capture timed out')); this.close(); }, 5000);
      this.waiting.push({ resolve: (b) => { clearTimeout(timer); resolve(b); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.proc!.stdin.write(`cap ${width}\n`);
    });
  }

  close() {
    const p = this.proc; this.proc = null;
    if (p) { try { p.stdin.write('quit\n'); } catch { /* ignore */ } setTimeout(() => p.kill(), 500); }
  }
}

export class ObsCapture implements Source {
  readonly name = 'OBS';
  private ws: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<string, { resolve: (d: any) => void; reject: (e: Error) => void }>();
  private format = 'bmp';

  constructor(private url: string, private password: string, private sourceName: string) {}

  private connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const fail = (e: Error) => { this.ready = null; this.ws = null; reject(e); };
      ws.on('error', (e) => fail(new Error(`OBS: ${e.message} (is OBS open with the WebSocket server enabled?)`)));
      ws.on('close', () => { this.ready = null; this.ws = null; for (const p of this.pending.values()) p.reject(new Error('OBS disconnected')); this.pending.clear(); });
      ws.on('message', (raw) => {
        const m = JSON.parse(String(raw));
        if (m.op === 0) {
          const d: any = { rpcVersion: 1, eventSubscriptions: 0 };
          const a = m.d.authentication;
          if (a) {
            const secret = createHash('sha256').update(this.password + a.salt).digest('base64');
            d.authentication = createHash('sha256').update(secret + a.challenge).digest('base64');
          }
          ws.send(JSON.stringify({ op: 1, d }));
        } else if (m.op === 2) {
          this.call('GetVersion').then((v) => {
            const f: string[] = v.supportedImageFormats ?? [];
            this.format = f.includes('bmp') ? 'bmp' : '';
            if (!this.format) return fail(new Error('This OBS build cannot output BMP screenshots.'));
            resolve();
          }, fail);
        } else if (m.op === 7) {
          const p = this.pending.get(m.d.requestId);
          if (!p) return;
          this.pending.delete(m.d.requestId);
          if (m.d.requestStatus?.result) p.resolve(m.d.responseData ?? {});
          else p.reject(new Error(`OBS: ${m.d.requestStatus?.comment ?? 'request failed'}`));
        }
      });
      ws.on('unexpected-response', () => fail(new Error('OBS refused the connection')));
      setTimeout(() => { if (this.ws === ws && ws.readyState !== WebSocket.OPEN) fail(new Error('OBS connection timed out')); }, 5000);
    });
    this.ready.catch(() => {});
    return this.ready;
  }

  private call(requestType: string, requestData?: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws) return reject(new Error('OBS not connected'));
      const requestId = randomUUID();
      this.pending.set(requestId, { resolve, reject });
      this.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
      setTimeout(() => { if (this.pending.delete(requestId)) reject(new Error('OBS request timed out')); }, 5000);
    });
  }

  async listSources(): Promise<string[]> {
    await this.connect();
    const r = await this.call('GetInputList');
    return (r.inputs ?? []).map((i: any) => i.inputName);
  }

  async grab(width: number): Promise<Buffer> {
    if (!this.sourceName) throw new Error('Pick the OBS source that shows the game (settings → OBS → Source name).');
    await this.connect();
    const r = await this.call('GetSourceScreenshot', { sourceName: this.sourceName, imageFormat: this.format, imageWidth: width });
    const data = String(r.imageData ?? '');
    return Buffer.from(data.slice(data.indexOf(',') + 1), 'base64');
  }

  close() { try { this.ws?.close(); } catch { /* ignore */ } this.ws = null; this.ready = null; }
}
