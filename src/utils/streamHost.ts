/**
 * Détecte les flux servis par une adresse IP nue (pas de nom de domaine).
 *
 * Un serveur en IP n'a pas de certificat valide : il ne peut être servi qu'en
 * http, donc une page https ne peut pas le charger (mixed content). L'extension
 * n'a pas cette limite et peut relayer le flux à sa place.
 */
export const isBareIpStreamUrl = (url: string): boolean => {
  const trimmed = typeof url === 'string' ? url.trim() : '';
  if (!trimmed) return false;

  let hostname: string;
  try {
    hostname = new URL(trimmed).hostname;
  } catch {
    return false;
  }
  if (!hostname) return false;

  // `URL` conserve les crochets des littéraux IPv6 dans `hostname`.
  if (hostname.startsWith('[') && hostname.endsWith(']')) return true;

  const octets = hostname.split('.');
  if (octets.length !== 4) return false;

  return octets.every((octet) => (
    /^\d{1,3}$/.test(octet) && Number(octet) <= 255
  ));
};
