import dns from 'node:dns';
import net from 'node:net';

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blocked.addSubnet(addr, prefix, 'ipv6');

export function isPrivateIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family === 6) {
    const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return blocked.check(mapped[1], 'ipv4');
    return blocked.check(ip, 'ipv6');
  }
  return true;
}

export class AddressError extends Error {}

/** Validate a node address. Returns a normalised ws:// or wss:// URL string. */
export function validateNodeAddr(addr, { requireTls = false, allowPrivate = false } = {}) {
  if (typeof addr !== 'string' || addr.length > 512) throw new AddressError('invalid address');
  let url;
  try {
    url = new URL(addr.trim());
  } catch {
    throw new AddressError('invalid address');
  }
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new AddressError('address must use ws:// or wss://');
  if (requireTls && url.protocol !== 'wss:') throw new AddressError('TLS (wss://) is required');
  if (!url.hostname) throw new AddressError('address has no host');
  if (url.username || url.password) throw new AddressError('credentials in address are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && net.isIP(host) && isPrivateIp(host)) throw new AddressError('private or loopback addresses are not allowed');
  if (!allowPrivate && ['localhost', 'localhost.localdomain'].includes(host.toLowerCase())) throw new AddressError('private or loopback addresses are not allowed');
  return url.toString().replace(/\/$/, '');
}

/**
 * dns.lookup replacement for outbound sockets that refuses private targets at
 * connect time, which also defeats DNS rebinding between validation and use.
 */
export function makeSafeLookup(allowPrivate) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
      const ok = allowPrivate ? list : list.filter((a) => !isPrivateIp(a.address));
      if (!ok.length) return callback(new AddressError(`refusing to connect to private address for ${hostname}`));
      if (options.all) return callback(null, ok);
      return callback(null, ok[0].address, ok[0].family);
    });
  };
}
