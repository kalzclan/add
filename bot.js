// IMPORTS AND INITIALIZATION
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN || '7971577643:AAFcL38ZrahWxEyyIcz3dO4aC9yq9LTAD5M';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://evberyanshxxalxtwnnc.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'your-supabase-key';
const PORT = process.env.PORT || 3000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let subscription;
let notificationQueue = [];
let isProcessingQueue = false;

// SET WEBHOOK
app.get('/set-webhook', async (req, res) => {
  try {
    const url = `${process.env.RAILWAY_PUBLIC_DOMAIN || `http://localhost:${PORT}`}/webhook`;
    const response = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${url}`);
    await startDepositMonitoring();
    res.send({ ...response.data, monitoring_status: 'Active', webhook_url: url });
  } catch (error) {
    console.error('Webhook setup failed:', error);
    res.status(500).send(error.message);
  }
});

// MONITORING DEPOSITS
async function startDepositMonitoring() {
  await backfillPendingDeposits();
  subscription = supabase
    .channel('deposit-monitor')
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'player_transactions',
      filter: 'transaction_type=eq.deposit'
    }, (payload) => {
      if (payload.new.status === 'pending') {
        notificationQueue.push(payload.new);
        processNotificationQueue();
      }
    })
    .subscribe();
}

async function processNotificationQueue() {
  if (isProcessingQueue || notificationQueue.length === 0) return;
  isProcessingQueue = true;
  const deposit = notificationQueue.shift();

  try {
    await sendDepositNotification(deposit);
  } catch (error) {
    console.error('Error processing deposit:', deposit.id, error);
    if (deposit.retryCount === undefined) deposit.retryCount = 0;
    if (deposit.retryCount < 3) {
      deposit.retryCount++;
      notificationQueue.push(deposit);
    }
  }

  isProcessingQueue = false;
  if (notificationQueue.length > 0) setTimeout(processNotificationQueue, 500);
}

async function backfillPendingDeposits() {
  try {
    const { data: deposits, error } = await supabase
      .from('player_transactions')
      .select('*')
      .eq('status', 'pending')
      .eq('transaction_type', 'deposit')
      .order('created_at', { ascending: false });

    if (error) throw error;
    notificationQueue.push(...deposits);
    processNotificationQueue();
  } catch (error) {
    console.error('Backfill error:', error);
  }
}

async function sendDepositNotification(deposit) {
  const message = `💰 *New Deposit Request* 💰\n\n` +
    `🆔 *ID:* ${deposit.id}\n` +
    `📱 *Phone:* ${deposit.player_phone}\n` +
    `💵 *Amount:* ${deposit.amount.toFixed(2)} ETB\n` +
    `📅 *Date:* ${new Date(deposit.created_at).toLocaleString()}\n` +
    `📝 *Description:* ${deposit.description || 'None'}\n\n` +
    `_Please review this deposit request_`;

  const response = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    chat_id: ADMIN_CHAT_ID,
    text: message,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: "✅ Approve", callback_data: `approve_${deposit.id}` },
        { text: "❌ Reject", callback_data: `reject_${deposit.id}` }
      ]]
    }
  });

  console.log(`Notification sent for deposit ${deposit.id}`);
  return response.data;
}

// WEBHOOK HANDLER
app.post('/webhook', async (req, res) => {
  const update = req.body;

  try {
    // Handle balance inquiry
    if (update.message && update.message.text === '/balance') {
      const phone = update.message.from.username;
      const { data: user } = await supabase.from('users').select('balance').eq('phone', phone).single();

      const msg = user
        ? `💳 Your current balance is: ${user.balance} ETB`
        : `❌ Could not find your balance.`;

      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: update.message.chat.id,
        text: msg
      });

      return res.send('OK');
    }

    // Handle transaction history
    if (update.message && update.message.text === '/history') {
      const phone = update.message.from.username;
      const { data: transactions } = await supabase
        .from('player_transactions')
        .select('*')
        .eq('player_phone', phone)
        .order('created_at', { ascending: false })
        .limit(5);

      let text = transactions.length ? '*🧾 Last 5 Transactions:*\n\n' : 'No transactions found.';
      for (const tx of transactions) {
        text += `• ${tx.transaction_type} - ${tx.amount} ETB (${tx.status})\n`;
      }

      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: update.message.chat.id,
        text,
        parse_mode: 'Markdown'
      });

      return res.send('OK');
    }

    // Handle callback (approve/reject)
    if (update.callback_query) {
      const [action, txId] = update.callback_query.data.split('_');
      const status = action === 'approve' ? 'approved' : 'rejected';

      if (action === 'approve') await updateUserBalance(txId);

      const { data: transaction, error } = await supabase
        .from('player_transactions')
        .update({ status, processed_at: new Date().toISOString(), processed_by: 'Telegram Bot' })
        .eq('id', txId)
        .select()
        .single();

      if (error) throw error;

      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
        callback_query_id: update.callback_query.id,
        text: `Transaction ${status}!`,
        show_alert: true
      });

      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
        chat_id: update.callback_query.message.chat.id,
        message_id: update.callback_query.message.message_id,
        text: `${update.callback_query.message.text}\n\nStatus: ${status.toUpperCase()}`,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [] }
      });
    }

    res.send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Error processing request');
  }
});

// UPDATE USER BALANCE
async function updateUserBalance(txId) {
  try {
    const { data: transaction } = await supabase.from('player_transactions').select('*').eq('id', txId).single();
    const { data: user } = await supabase.from('users').select('balance').eq('phone', transaction.player_phone).single();
    const newBalance = (user?.balance || 0) + transaction.amount;
    await supabase.from('users').update({ balance: newBalance }).eq('phone', transaction.player_phone);
    console.log(`Updated balance for ${transaction.player_phone}`);
  } catch (error) {
    console.error('Balance update error:', error);
    throw error;
  }
}

// DAILY SUMMARY
app.get('/daily-summary', async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('get_daily_summary');
    if (error) throw error;
    res.send(data);
  } catch (error) {
    console.error('Summary error:', error);
    res.status(500).send('Error getting summary');
  }
});

// HEALTH CHECK
app.get('/', (req, res) => {
  res.send(`
    <h1>Deposit Approval System</h1>
    <p>Server is running!</p>
    <ul>
      <li><a href="/set-webhook">Setup Webhook</a></li>
      <li><a href="/daily-summary">Daily Summary</a></li>
      <li>Webhook URL: <code>/webhook</code></li>
      <li>Monitoring Status: ${subscription ? 'Active' : 'Inactive'}</li>
      <li>Pending Notifications: ${notificationQueue.length}</li>
    </ul>
  `);
});

// START SERVER
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  if (process.env.NODE_ENV === 'production') startDepositMonitoring();
});
