// A readable default name for a device from its User-Agent ("iPhone · Home screen app",
// "Mac · Safari"). Only a starting point: either person can rename any device.
export function deviceNameFromUserAgent(ua, { installed = false } = {}) {
  const s = typeof ua === 'string' ? ua : '';
  let platform = 'Unknown device';
  if (/iPhone/.test(s)) platform = 'iPhone';
  else if (/iPad/.test(s)) platform = 'iPad';
  else if (/Android/.test(s)) platform = /Mobile/.test(s) ? 'Android phone' : 'Android tablet';
  else if (/Macintosh|Mac OS X/.test(s)) platform = 'Mac';
  else if (/Windows/.test(s)) platform = 'Windows PC';
  else if (/CrOS/.test(s)) platform = 'Chromebook';
  else if (/Linux/.test(s)) platform = 'Linux';

  let browser = null;
  if (/Edg(e|A|iOS)?\//.test(s)) browser = 'Edge';
  else if (/Firefox\/|FxiOS\//.test(s)) browser = 'Firefox';
  else if (/Chrome\/|CriOS\//.test(s)) browser = 'Chrome';
  else if (/Safari\//.test(s)) browser = 'Safari';

  if (installed) return `${platform} · Home screen app`;
  return browser ? `${platform} · ${browser}` : platform;
}
