const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// Environment variables (Railway will inject these)
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Webhook setup endpoint
app.get('/set-webhook', async (req, res) => {
  try {
    const url = `${process.env.RAILWAY_PUBLIC_DOMAIN}/webhook`;
    const response = await axios.get(
      `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${url}`
    );
    res.send(response.data);
  } catch (error) {
    console.error('Webhook setup failed:', error);
    res.status(500).send(error.message);
  }
});

// Webhook handler
app.post('/webhook', async (req, res) => {
  try {
    const update = req.body;
    
    if (update.callback_query) {
      const [action, txId] = update.callback_query.data.split('_');
      const status = action === 'approve' ? 'approved' : 'rejected';

      // Update Supabase
      const { error } = await supabase
        .from('player_transactions')
        .update({ 
          status,
          processed_at: new Date().toISOString()
        })
        .eq('id', txId);

      if (error) throw error;

      // Telegram API responses
      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
        callback_query_id: update.callback_query.id,
        text: `Transaction ${status}!`
      });

      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
        chat_id: update.callback_query.message.chat.id,
        message_id: update.callback_query.message.message_id,
        text: `${update.callback_query.message.text}\n\nStatus: ${status.toUpperCase()}`,
        reply_markup: { inline_keyboard: [] } // Remove buttons after action
      });
    }
    
    res.send('OK');
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).send('Error processing request');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
  console.log(`Webhook URL: ${process.env.RAILWAY_PUBLIC_DOMAIN}/webhook`);
});
// Add this route handler
app.get('/', (req, res) => {
  res.send(`
    <h1>Telegram Approval Bot</h1>
    <p>Bot is running!</p>
    <ul>
      <li><a href="/set-webhook">Setup Webhook</a></li>
      <li>Webhook URL: <code>/webhook</code></li>
    </ul>
  `);
});
