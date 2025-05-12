const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js'); // Add this

const app = express();
app.use(express.json());

const BOT_TOKEN = '7971577643:AAFcL38ZrahWxEyyIcz3dO4aC9yq9LTAD5M';
const ADMIN_CHAT_ID = '1133538088';
const SUPABASE_URL = 'https://evberyanshxxalxtwnnc.supabase.co'; // Add your Supabase URL
const SUPABASE_KEY = 'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV2YmVyeWFuc2h4eGFseHR3bm5jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDQwODMwOTcsImV4cCI6MjA1OTY1OTA5N30'; // Replace with your key

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY); // Initialize Supabase

// Set webhook (run this once)
app.get('/set-webhook', async (req, res) => {
  try {
    const url = `https://your-deployed-url.vercel.app/webhook`; // ← REPLACE with your actual URL
    const response = await axios.get(
      `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${url}`
    );
    res.send(response.data);
  } catch (error) {
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

      // 1. Update Supabase
      const { error } = await supabase
        .from('player_transactions')
        .update({ status })
        .eq('id', txId);

      if (error) throw error;

      // 2. Send confirmation to Telegram
      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
        callback_query_id: update.callback_query.id,
        text: `Transaction ${status}!`
      });

      // 3. Update the original message (optional)
      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
        chat_id: update.callback_query.message.chat.id,
        message_id: update.callback_query.message.message_id,
        text: `${update.callback_query.message.text}\n\nStatus: ${status}`
      });
    }
    
    res.send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Error processing request');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));