import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { badRequest } from '../../lib/errors.js';

/** Only globally routable unicast addresses are allowed (no loopback, private, link-local, metadata, etc). */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let ip = ipaddr.parse(address);
  if (ip.kind() === 'ipv6' && (ip as ipaddr.IPv6).isIPv4MappedAddress()) {
    ip = (ip as ipaddr.IPv6).toIPv4Address();
  }
  return ip.range() === 'unicast';
}

export interface UrlPolicy {
  allowPrivate: boolean;
  requireHttps: boolean;
}

/** Static checks on a webhook URL. DNS-based checks happen at connect time (see guardedLookup). */
export function assertWebhookUrl(raw: string, policy: UrlPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('Webhook URL is not a valid URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !policy.requireHttps)) {
    throw badRequest(
      policy.requireHttps ? 'Webhook URL must use https' : 'Webhook URL must use http or https',
    );
  }
  if (url.username || url.password) throw badRequest('Webhook URL must not contain credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!policy.allowPrivate) {
    if (isIP(host) && !isPublicAddress(host))
      throw badRequest('Webhook URL must not target a private address');
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) {
      throw badRequest('Webhook URL must not target a private host');
    }
  }
  return url;
}

/**
 * DNS lookup for http.request that refuses non-public results. Because the check runs on the
 * address actually used for the connection, DNS rebinding between validation and send is moot.
 */
export function guardedLookup(allowPrivate: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
      if (err) return callback(err, '', 0);
      const blocked = !allowPrivate && addresses.find((a) => !isPublicAddress(a.address));
      if (blocked || addresses.length === 0) {
        const e = Object.assign(new Error(`Refusing to connect to non-public address for ${hostname}`), {
          code: 'ESSRF',
        });
        return callback(e, '', 0);
      }
      if (options.all) {
        (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
      } else {
        const first = addresses[0]!;
        callback(null, first.address, first.family);
      }
    });
  };
}
