/**
 * Native Switcher smart plug client — replaces switcher-js2.
 * Protocol based on aioswitcher (Apache 2.0, github.com/TomerFi/aioswitcher).
 * Supports Type 1 devices: V2, Touch, V4, Mini, Power Plug (port 9957).
 */

import * as net from 'net';
import * as dgram from 'dgram';
import * as crypto from 'crypto';

// --- Constants ---

const TOKEN_KEY = Buffer.from('jzNrAOjc%lpg3pVr5cF!5Le06ZgOdWuJ');
const MAGIC = 'fef0';
const TCP_PORT = 9957;
const UDP_PORTS = [20002, 10002];
const TYPE1_BROADCAST_SIZE = 165; // bytes

// --- Token decryption ---

export function decryptToken(base64Token: string): string {
  const encrypted = Buffer.from(base64Token, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-ecb', TOKEN_KEY, null);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('hex');
}

// --- CRC-CCITT (polynomial 0x1021, init 0x1021) ---

function crcCCITT(buf: Buffer): number {
  let crc = 0x1021;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i] << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xFFFF;
    }
  }
  return crc;
}

function crcToSwapped(crc: number): string {
  // Pack as big-endian 32-bit, take bytes [3]+[2] (little-endian swap of lower 16)
  const hex = crc.toString(16).padStart(8, '0');
  return hex.slice(6, 8) + hex.slice(4, 6);
}

// --- Packet utilities ---

function signPacket(hexPacket: string): string {
  const packetBuf = Buffer.from(hexPacket, 'hex');
  const packetCrc = crcCCITT(packetBuf);
  const packetCrcHex = crcToSwapped(packetCrc);

  // Key: packetCrc bytes + 32 bytes of 0x30
  const keyHex = packetCrcHex + '30'.repeat(32);
  const keyBuf = Buffer.from(keyHex, 'hex');
  const keyCrc = crcCCITT(keyBuf);
  const keyCrcHex = crcToSwapped(keyCrc);

  return hexPacket + packetCrcHex + keyCrcHex;
}

function setMessageLength(hexPacket: string): string {
  const totalBytes = (hexPacket.length / 2) + 4; // +4 for CRC that will be appended
  const lengthHex = totalBytes.toString(16).padEnd(4, '0');
  return MAGIC + lengthHex + hexPacket.slice(8);
}

function timestampHex(): string {
  const ts = Math.floor(Date.now() / 1000);
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(ts);
  return buf.toString('hex');
}

function timerHex(minutes: number): string {
  const seconds = minutes * 60;
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(seconds);
  return buf.toString('hex');
}

// --- Packet builders ---

function buildLoginPacket(deviceKey: string): string {
  const ts = timestampHex();
  const packet =
    'fef052000232a100' +
    '00000000' +                          // session id (initial)
    '340001000000000000000000' +
    ts +
    '00000000000000000000f0fe' +
    deviceKey +
    '0'.repeat(72) +
    '00';
  return packet;
}

function buildControlPacket(
  sessionId: string, deviceId: string, command: '0' | '1', minutes: number,
): string {
  const ts = timestampHex();
  const timer = command === '1' ? timerHex(minutes) : '00000000';
  const packet =
    'fef05d0002320102' +
    sessionId +
    '340001000000000000000000' +
    ts +
    '00000000000000000000f0fe' +
    deviceId +
    '00' +
    '0'.repeat(72) +
    '0106000' + command + '00' + timer;
  return packet;
}

// --- TCP session ---

function preparePacket(hexPacket: string): Buffer {
  return Buffer.from(signPacket(setMessageLength(hexPacket)), 'hex');
}

function extractSessionId(response: Buffer): string {
  return response.toString('hex').slice(16, 24);
}

/**
 * Open a TCP connection, login, send a command, and close.
 * Keeps the connection open between login and command so the session is valid.
 */
function loginAndSend(
  ip: string, loginPacket: string, commandPacket: (sessionId: string) => string,
  timeoutMs = 10000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let phase: 'login' | 'command' | 'done' = 'login';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error(`Switcher TCP timeout (phase: ${phase})`));
      }
    }, timeoutMs);

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      err ? reject(err) : resolve();
    };

    socket.connect(TCP_PORT, ip, () => {
      socket.write(preparePacket(loginPacket));
    });

    socket.on('data', (data) => {
      if (settled) return;

      if (phase === 'login') {
        const sessionId = extractSessionId(data);
        phase = 'command';
        socket.write(preparePacket(commandPacket(sessionId)));
      } else if (phase === 'command') {
        phase = 'done';
        if (data.length > 0) {
          finish();
        } else {
          finish(new Error('Switcher: empty command response'));
        }
      }
    });

    socket.on('error', (err) => {
      finish(new Error(`Switcher TCP error: ${err.message}`));
    });
  });
}

// --- Discovery ---

export interface DiscoveredDevice {
  deviceId: string;
  deviceKey: string;
  ip: string;
  name: string;
  state: 'on' | 'off';
}

export function discover(
  targetDeviceId: string, timeoutMs = 10000,
): Promise<DiscoveredDevice> {
  return new Promise((resolve, reject) => {
    const sockets: dgram.Socket[] = [];
    let found = false;

    const timer = setTimeout(() => {
      if (!found) {
        found = true;
        cleanup();
        reject(new Error(`Switcher device ${targetDeviceId} not found on network (${timeoutMs / 1000}s timeout)`));
      }
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      for (const s of sockets) {
        try { s.close(); } catch { /* ignore */ }
      }
    };

    for (const port of UDP_PORTS) {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sockets.push(socket);

      socket.on('message', (msg) => {
        if (found) return;
        if (msg.length !== TYPE1_BROADCAST_SIZE) return;

        const hex = msg.toString('hex');
        if (!hex.startsWith(MAGIC)) return;

        const deviceId = hex.slice(36, 42);
        const deviceKey = hex.slice(80, 82);

        // Device name: bytes 42-74 (raw, not hex), null-terminated
        const nameBytes = msg.slice(42, 74);
        const nullIdx = nameBytes.indexOf(0);
        const name = nameBytes.slice(0, nullIdx >= 0 ? nullIdx : nameBytes.length).toString('utf-8');

        // IP: 4 bytes at hex offset 152-160, each byte is one octet
        const ipHex = hex.slice(152, 160);
        const ip = [
          parseInt(ipHex.slice(0, 2), 16),
          parseInt(ipHex.slice(2, 4), 16),
          parseInt(ipHex.slice(4, 6), 16),
          parseInt(ipHex.slice(6, 8), 16),
        ].join('.');

        // State at hex offset 266-268
        const state = hex.slice(266, 268) === '01' ? 'on' : 'off';

        // Match by device ID, name, or IP
        const target = targetDeviceId.toLowerCase();
        if (deviceId.toLowerCase() === target ||
            name.toLowerCase() === target.toLowerCase() ||
            ip === targetDeviceId) {
          found = true;
          cleanup();
          resolve({ deviceId, deviceKey, ip, name, state });
        }
      });

      socket.on('error', () => { /* ignore binding errors */ });

      socket.bind(port, () => {
        socket.setBroadcast(true);
      });
    }
  });
}

// --- Public API ---

export async function switcherTurnOn(
  deviceId: string, ip: string, deviceKey: string, minutes: number,
): Promise<void> {
  await loginAndSend(
    ip,
    buildLoginPacket(deviceKey),
    (sessionId) => buildControlPacket(sessionId, deviceId, '1', minutes),
  );
}

export async function switcherTurnOff(
  deviceId: string, ip: string, deviceKey: string,
): Promise<void> {
  await loginAndSend(
    ip,
    buildLoginPacket(deviceKey),
    (sessionId) => buildControlPacket(sessionId, deviceId, '0', 0),
  );
}
