// Simple text-based captcha without canvas dependency for Railway compatibility
function generateCaptcha() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let text = '';
  for (let i = 0; i < 5; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return {
    text: text.toLowerCase(),
    display: text
  };
}

function validateCaptcha(userInput, correct) {
  if (!userInput || !correct) return false;
  return userInput.toLowerCase().trim() === correct.toLowerCase().trim();
}

module.exports = { generateCaptcha, validateCaptcha };
