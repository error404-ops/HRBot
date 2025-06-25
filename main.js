// Run the bot (index.js)
require('./index');

// Start Express
const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.send('HRBot is running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Express server started on port ${PORT}`);
});
