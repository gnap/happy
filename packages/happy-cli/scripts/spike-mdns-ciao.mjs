/**
 * P2 可行性验证 spike（备选实现）—— @homebridge/ciao
 *
 * 背景：bonjour-service (multicast-dns) 在 macOS 上收不到 5353 多播包，
 *       且发包需绕 interface/bind 坑。ciao 是 Homebridge 使用的实现，自行处理多网卡。
 *
 * 用法：
 *   node scripts/spike-mdns-ciao.mjs advertise [秒数]
 */
import { getResponder } from '@homebridge/ciao';

const SERVICE_TYPE = 'happy';
const PORT = 51234;
const NAME = 'happy-mach-spike-001';

const responder = getResponder();

const service = responder.createService({
  name: NAME,
  type: SERVICE_TYPE,
  port: PORT,
  txt: {
    v: '1',
    accountId: 'acct-spike-deadbeef',
    machineId: NAME,
    pubKey: 'spike-pubkey-base64url',
  },
});

try {
  await service.advertise();
  console.log(`[ciao] 已通告 _${SERVICE_TYPE}._tcp.local  name=${NAME}  port=${PORT}`);
} catch (e) {
  console.error('[ciao] advertise 失败:', e?.message ?? e);
  process.exit(1);
}

const seconds = Number(process.argv[3] ?? 20);
console.log(`[ciao] 保持运行 ${seconds}s ...`);
setTimeout(async () => {
  try { await service.end(); await responder.shutdown(); } catch {}
  process.exit(0);
}, seconds * 1000);
