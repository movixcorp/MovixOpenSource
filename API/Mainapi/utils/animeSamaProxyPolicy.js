function shouldRotateAnimeSamaResponse(status, body = '') {
  const statusCode = Number(status);

  if ([403, 407, 408, 425, 429].includes(statusCode)) {
    return true;
  }

  if (statusCode >= 500 && statusCode < 600) {
    return true;
  }

  const bodyText = typeof body === 'string' ? body.toLowerCase() : '';
  return (
    bodyText.includes('cf-wrapper') ||
    bodyText.includes('cloudflare') ||
    bodyText.includes('just a moment')
  );
}

module.exports = { shouldRotateAnimeSamaResponse };

