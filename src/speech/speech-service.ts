// Cliente do serviço de voz em Python (services/speech). Abre o processo uma vez e conversa por JSON
// em stdin/stdout. O processo carrega Kokoro + Whisper (~25 s), então fica aberto a sessão toda.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { PushToTalkStt, TextToSpeech, Transcript } from '../core/interfaces.ts';
import type { Language } from '../core/types.ts';

const SERVICE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../services/speech');
const PYTHON = path.join(SERVICE_DIR, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

type Msg = { id?: number; type: string; [k: string]: unknown };

export interface SpeechReady {
  loadMs: number;
  whisper: string;
  input: string;
  output: string;
}

export class SpeechService implements TextToSpeech, PushToTalkStt {
  readonly engine = 'kokoro+faster-whisper';
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private waiting = new Map<number, { resolve: (m: Msg) => void; reject: (e: Error) => void }>();
  private listenId: number | null = null;

  constructor(private readonly env: Record<string, string> = {}) {}

  /** Sobe o processo e espera os modelos carregarem. */
  start(timeoutMs = 180_000): Promise<SpeechReady> {
    if (!existsSync(PYTHON)) {
      return Promise.reject(new Error(`ambiente de voz não instalado: falta ${PYTHON} (ver services/speech/README.md)`));
    }
    const proc = spawn(PYTHON, ['-m', 'night_speech'], {
      cwd: SERVICE_DIR,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', ...this.env },
    });
    this.proc = proc;
    let stderrTail = '';
    proc.stderr.on('data', (d: Buffer) => { stderrTail = (stderrTail + d.toString()).slice(-4000); });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('serviço de voz não ficou pronto a tempo')), timeoutMs);
      proc.on('exit', (code) => {
        clearTimeout(timer);
        const err = new Error(`serviço de voz saiu (código ${code}). Final do log:\n${stderrTail.split('\n').slice(-6).join('\n')}`);
        reject(err);
        for (const w of this.waiting.values()) w.reject(err);
        this.waiting.clear();
        this.proc = null;
      });
      createInterface({ input: proc.stdout }).on('line', (line) => {
        if (!line.trim()) return;
        let msg: Msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.type === 'ready') {
          clearTimeout(timer);
          resolve({ loadMs: Number(msg.load_ms), whisper: String(msg.whisper), input: String(msg.input), output: String(msg.output) });
          return;
        }
        const w = msg.id != null ? this.waiting.get(msg.id) : undefined;
        if (!w) return;
        if (msg.type === 'listening') return; // confirmação intermediária; a resposta é o 'final'
        this.waiting.delete(msg.id!);
        if (msg.type === 'error') w.reject(new Error(String(msg.message)));
        else w.resolve(msg);
      });
    });
  }

  private request(payload: Record<string, unknown>): Promise<Msg> {
    if (!this.proc) return Promise.reject(new Error('serviço de voz não está rodando'));
    const id = this.nextId++;
    const done = new Promise<Msg>((resolve, reject) => this.waiting.set(id, { resolve, reject }));
    this.proc.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
    return done;
  }

  private send(payload: Record<string, unknown>): void {
    this.proc?.stdin.write(JSON.stringify(payload) + '\n');
  }

  async speak(text: string, language: Language): Promise<{ interrupted: boolean }> {
    if (!text.trim()) return { interrupted: false };
    const r = await this.request({ type: 'speak', text, lang: language });
    return { interrupted: Boolean(r.interrupted) };
  }

  stop(): void {
    this.send({ type: 'stop' });
  }

  get listening(): boolean {
    return this.listenId !== null;
  }

  /** Abre o microfone (e cala o Night, se estiver falando). */
  startListening(): void {
    if (this.listenId !== null) throw new Error('já está ouvindo');
    this.listenId = this.nextId++;
    this.proc?.stdin.write(JSON.stringify({ id: this.listenId, type: 'listen_start' }) + '\n');
  }

  /** Fecha o microfone e devolve o que foi dito. */
  async stopListening(languageHint?: Language): Promise<Transcript> {
    if (this.listenId === null) throw new Error('não estava ouvindo');
    const id = this.listenId;
    this.listenId = null;
    const done = new Promise<Msg>((resolve, reject) => this.waiting.set(id, { resolve, reject }));
    this.proc?.stdin.write(JSON.stringify({ id, type: 'listen_stop', lang: languageHint ?? null }) + '\n');
    return toTranscript(await done);
  }

  /** Testes: transcreve um WAV sem microfone. */
  async transcribeFile(file: string, languageHint?: Language): Promise<Transcript> {
    return toTranscript(await this.request({ type: 'transcribe_file', path: file, lang: languageHint ?? null }));
  }

  /** Testes: gera um WAV sem tocar. */
  async synthesizeToFile(text: string, language: Language, file: string): Promise<{ audioSeconds: number }> {
    const r = await this.request({ type: 'synth_file', text, lang: language, path: file });
    return { audioSeconds: Number(r.audio_s) };
  }

  async close(): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    const exited = new Promise<void>((r) => proc.once('exit', () => r()));
    this.send({ type: 'shutdown' });
    proc.stdin.end();
    const timer = setTimeout(() => proc.kill(), 5000);
    await exited;
    clearTimeout(timer);
  }
}

function toTranscript(m: Msg): Transcript {
  return {
    text: String(m.text ?? ''),
    language: (m.language as Language | null) ?? null,
    audioSeconds: Number(m.audio_s ?? 0),
    ms: Number(m.ms ?? 0),
  };
}
