const { handleApi } = require('../lib/core');

module.exports = async (req, res) => {
  try {
    await handleApi(req, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: e.message || 'Server error' });
  }
};
