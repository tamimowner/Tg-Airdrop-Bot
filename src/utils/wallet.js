/**
 * Validate BEP-20 (BSC) wallet address
 * Starts with 0x and is 42 chars hex
 */
function isValidBEP20Address(address) {
  if (!address || typeof address !== 'string') return false;
  const trimmed = address.trim();
  return /^0x[a-fA-F0-9]{40}$/.test(trimmed);
}

function normalizeAddress(address) {
  if (!address) return null;
  return address.trim().toLowerCase();
}

module.exports = { isValidBEP20Address, normalizeAddress };
