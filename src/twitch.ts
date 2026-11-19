// Twitch connection: OAuth, chat, EventSub (bits/subs/redeems/follows/raids) and predictions.
import { randomBytes } from 'node:crypto';
import { RefreshingAuthProvider, exchangeCode, type AccessToken } from '@twurple/auth';
import { ApiClient } from '@twurple/api';
import { ChatClient } from '@twurple/chat';
import { EventSubWsListener } from '@twurple/eventsub-ws';
import { readJson, writeJson, type Config } from './config.js';

export const SCOPES = [
  'chat:read', 'chat:edit',
  'channel:read:redemptions', 'bits:read', 'channel:read:subscriptions',
  'moderator:read:followers', 'channel:manage:predictions',
];

export interface TwitchEvent {
  source: 'twitch';
  type: 'chat' | 'bits' | 'sub' | 'resub' | 'gift' | 'follow' | 'raid' | 'redeem';
  user: string;
  amount?: number;
  message?: string;
  rewardTitle?: string;
  isMod?: boolean;
  isBroadcaster?: boolean;
  ts: number;
}

type ChatHandler = (text: string, user: string, isMod: boolean, isBroadcaster: boolean) => void;

export class Twitch {
  status = 'not connected';
  login = '';
  userId = '';
  private auth?: RefreshingAuthProvider;
  private api?: ApiClient;
  private chat?: ChatClient;
  private eventsub?: EventSubWsListener;
  private oauthState = '';
  private prediction: { id: string; outcomes: { id: string; title: string }[] } | null = null;

  constructor(private getConfig: () => Config, private onEvent: (e: TwitchEvent) => void, private onChat: ChatHandler) {}

  get redirectUri() { return `http://localhost:${this.getConfig().port}/auth/callback`; }

  authUrl() {
    const { clientId } = this.getConfig().twitch;
    this.oauthState = randomBytes(16).toString('hex');
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: this.redirectUri, response_type: 'code', scope: SCOPES.join(' '), state: this.oauthState, force_verify: 'true' });
    return `https://id.twitch.tv/oauth2/authorize?${q}`;
  }

  async handleCallback(code: string, state: string) {
    if (!state || state !== this.oauthState) throw new Error('OAuth state mismatch, try connecting again.');
    const { clientId, clientSecret } = this.getConfig().twitch;
    const token = await exchangeCode(clientId, clientSecret, code, this.redirectUri);
    writeJson('tokens.json', token);
    await this.connect();
  }

  async connect() {
    await this.disconnect();
    const cfg = this.getConfig();
    const { clientId, clientSecret } = cfg.twitch;
    const token = readJson<AccessToken | null>('tokens.json', null);
    if (!clientId || !clientSecret) { this.status = 'missing client ID / secret'; return; }
    if (!token) { this.status = 'not authorized: click "Connect Twitch"'; return; }

    try {
      this.status = 'connecting…';
      this.auth = new RefreshingAuthProvider({ clientId, clientSecret });
      this.auth.onRefresh((_id, t) => writeJson('tokens.json', t));
      this.userId = await this.auth.addUserForToken(token, ['chat']);
      this.api = new ApiClient({ authProvider: this.auth });
      const me = await this.api.users.getUserById(this.userId);
      this.login = (cfg.twitch.channel || me?.name || '').toLowerCase();

      this.chat = new ChatClient({ authProvider: this.auth, channels: [this.login] });
      this.chat.onMessage((_ch, _user, text, msg) => {
        const u = msg.userInfo;
        this.onChat(text, u.displayName, u.isMod, u.isBroadcaster);
        this.onEvent({ source: 'twitch', type: 'chat', user: u.displayName, message: text, isMod: u.isMod, isBroadcaster: u.isBroadcaster, ts: Date.now() });
      });
      await this.chat.connect();

      const uid = this.userId;
      const es = new EventSubWsListener({ apiClient: this.api });
      const safe = (fn: () => void) => { try { fn(); } catch (e) { console.warn('[twitch] eventsub subscribe failed', e); } };
      safe(() => es.onChannelCheer(uid, (e) => this.emit('bits', e.isAnonymous ? 'Anonymous' : (e.userDisplayName ?? 'Anonymous'), { amount: e.bits, message: e.message })));
      safe(() => es.onChannelSubscription(uid, (e) => { if (!e.isGift) this.emit('sub', e.userDisplayName, { amount: 1 }); }));
      safe(() => es.onChannelSubscriptionMessage(uid, (e) => this.emit('resub', e.userDisplayName, { amount: e.cumulativeMonths, message: e.messageText })));
      safe(() => es.onChannelSubscriptionGift(uid, (e) => this.emit('gift', e.isAnonymous ? 'Anonymous' : (e.gifterDisplayName ?? 'Anonymous'), { amount: e.amount })));
      safe(() => es.onChannelFollow(uid, uid, (e) => this.emit('follow', e.userDisplayName)));
      safe(() => es.onChannelRaidTo(uid, (e) => this.emit('raid', e.raidingBroadcasterDisplayName, { amount: e.viewers })));
      safe(() => es.onChannelRedemptionAdd(uid, (e) => this.emit('redeem', e.userDisplayName, { rewardTitle: e.rewardTitle, message: e.input })));
      es.start();
      this.eventsub = es;
      this.status = `connected as ${me?.displayName ?? this.login}`;
      console.log('[twitch]', this.status);
    } catch (e) {
      this.status = `error: ${(e as Error).message}`;
      console.error('[twitch]', e);
    }
  }

  async disconnect() {
    try { this.eventsub?.stop(); } catch { /* ignore */ }
    try { this.chat?.quit(); } catch { /* ignore */ }
    this.eventsub = undefined; this.chat = undefined; this.api = undefined;
    this.status = 'not connected';
  }

  private emit(type: TwitchEvent['type'], user: string, extra: Partial<TwitchEvent> = {}) {
    this.onEvent({ source: 'twitch', type, user, ts: Date.now(), ...extra });
  }

  get connected() { return !!this.chat; }

  async say(text: string) {
    if (!this.chat || !this.login) return;
    try { await this.chat.say(this.login, text.slice(0, 490)); } catch (e) { console.warn('[twitch] say failed', e); }
  }

  // ---- Predictions ----
  async startPrediction(playerCount: number) {
    const p = this.getConfig().predictions;
    if (!p.enabled || !this.api) return;
    if (this.prediction) await this.cancelPrediction();
    const outcomes = p.mode === 'first' ? ['Yes, 1st place', 'No'] : ['1st', '2nd', '3rd', '4th'].slice(0, playerCount || 4);
    try {
      const pred = await this.api.predictions.createPrediction(this.userId, {
        title: (p.mode === 'first' ? p.titleFirst : p.titlePlacement).slice(0, 45),
        outcomes, autoLockAfter: Math.min(1800, Math.max(30, p.windowSec)),
      });
      this.prediction = { id: pred.id, outcomes: pred.outcomes.map((o) => ({ id: o.id, title: o.title })) };
    } catch (e) { console.warn('[twitch] prediction failed', (e as Error).message); }
  }

  async resolvePrediction(place: number | null) {
    if (!this.prediction || !this.api) return;
    const pred = this.prediction; this.prediction = null;
    if (!place) return void this.api.predictions.cancelPrediction(this.userId, pred.id).catch(() => {});
    const idx = this.getConfig().predictions.mode === 'first' ? (place === 1 ? 0 : 1) : place - 1;
    const outcome = pred.outcomes[idx];
    try { if (outcome) await this.api.predictions.resolvePrediction(this.userId, pred.id, outcome.id); } catch (e) { console.warn('[twitch] resolve failed', (e as Error).message); }
  }

  async cancelPrediction() {
    if (!this.prediction || !this.api) return;
    const id = this.prediction.id; this.prediction = null;
    await this.api.predictions.cancelPrediction(this.userId, id).catch(() => {});
  }
}
