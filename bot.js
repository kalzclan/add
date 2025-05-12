const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// Environment variables
const BOT_TOKEN = process.env.BOT_TOKEN || '7971577643:AAFcL38ZrahWxEyyIcz3dO4aC9yq9LTAD5M';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://evberyanshxxalxtwnnc.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'your-supabase-key';
const PORT = process.env.PORT || 3000;

// Initialize Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Realtime subscription setup
let subscription;
let notificationQueue = [];
let isProcessingQueue = false;

// Webhook setup endpoint
app.get('/set-webhook', async (req, res) => {
  try {
    const url = `${process.env.RAILWAY_PUBLIC_DOMAIN || `http://localhost:${PORT}`}/webhook`;
    const response = await axios.get(
      `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${url}`
    );
    
    // Start monitoring after webhook is set
    await startDepositMonitoring();
    
    res.send({
      ...response.data,
      monitoring_status: 'Active',
      webhook_url: url
    });
  } catch (error) {
    console.error('Webhook setup failed:', error);
    res.status(500).send(error.message);
  }
});

// Start monitoring deposits
async function startDepositMonitoring() {
  // First backfill any pending deposits
  await backfillPendingDeposits();
  
  // Then setup realtime listener
  subscription = supabase
    .channel('deposit-monitor')
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'player_transactions',
        filter: 'transaction_type=eq.deposit'
      },
      (payload) => {
        if (payload.new.status === 'pending') {
          notificationQueue.push(payload.new);
          processNotificationQueue();
        }
      }
    )
    .subscribe();
}

// Process pending deposits queue
async function processNotificationQueue() {
  if (isProcessingQueue || notificationQueue.length === 0) return;
  
  isProcessingQueue = true;
  const deposit = notificationQueue.shift();
  
  try {
    await sendDepositNotification(deposit);
  } catch (error) {
    console.error('Error processing deposit:', deposit.id, error);
    // Retry logic
    if (deposit.retryCount === undefined) deposit.retryCount = 0;
    if (deposit.retryCount < 3) {
      deposit.retryCount++;
      notificationQueue.push(deposit);
    }
  }
  
  isProcessingQueue = false;
  if (notificationQueue.length > 0) {
    setTimeout(processNotificationQueue, 500); // Rate limiting
  }
}

// Backfill any existing pending deposits
async function backfillPendingDeposits() {
  try {
    const { data: deposits, error } = await supabase
      .from('player_transactions')
      .select('*')
      .eq('status', 'pending')
      .eq('transaction_type', 'deposit')
      .order('created_at', { ascending: false });

    if (error) throw error;

    console.log(`Backfilling ${deposits.length} pending deposits`);
    notificationQueue.push(...deposits);
    processNotificationQueue();
  } catch (error) {
    console.error('Backfill error:', error);
  }
}

// Send notification to Telegram
async function sendDepositNotification(deposit) {
  const message = `💰 *New Deposit Request* 💰\n\n` +
                 `🆔 *ID:* ${deposit.id}\n` +
                 `📱 *Phone:* ${deposit.player_phone}\n` +
                 `💵 *Amount:* ${deposit.amount.toFixed(2)} ETB\n` +
                 `📅 *Date:* ${new Date(deposit.created_at).toLocaleString()}\n` +
                 `📝 *Description:* ${deposit.description || 'None'}\n\n` +
                 `_Please review this deposit request_`;

  const response = await axios.post(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      chat_id: ADMIN_CHAT_ID,
      text: message,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: `approve_${deposit.id}` },
            { text: "❌ Reject", callback_data: `reject_${deposit.id}` }
          ]
        ]
      }
    }
  );

  console.log(`Notification sent for deposit ${deposit.id}`);
  return response.data;
}

// Webhook handler
app.post('/webhook', async (req, res) => {
  try {
    const update = req.body;
    
    if (update.callback_query) {
      const [action, txId] = update.callback_query.data.split('_');
      const status = action === 'approve' ? 'approved' : 'rejected';

      // Update user balance if approved
      if (action === 'approve') {
        await updateUserBalance(txId);
      }

      // Update transaction status
      const { data: transaction, error } = await supabase
        .from('player_transactions')
        .update({ 
          status,
          processed_at: new Date().toISOString(),
          processed_by: 'Telegram Bot'
        })
        .eq('id', txId)
        .select()
        .single();

      if (error) throw error;

      // Telegram API responses
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
        reply_markup: { inline_keyboard: [] } // Remove buttons
      });

      console.log(`Transaction ${txId} ${status}`);
    }
    
    res.send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Error processing request');
  }
});

// Update user balance when deposit is approved
async function updateUserBalance(txId) {
  try {
    // Get transaction details
    const { data: transaction, error } = await supabase
      .from('player_transactions')
      .select('*')
      .eq('id', txId)
      .single();

    if (error || !transaction) throw new Error('Transaction not found');

    // Update user balance
    const { data: user } = await supabase
      .from('users')
      .select('balance')
      .eq('phone', transaction.player_phone)
      .single();

    const newBalance = (user?.balance || 0) + transaction.amount;

    await supabase
      .from('users')
      .update({ balance: newBalance })
      .eq('phone', transaction.player_phone);

    console.log(`Updated balance for ${transaction.player_phone}`);
  } catch (error) {
    console.error('Balance update error:', error);
    throw error;
  }
}

// Health check endpoint
app.get('/', (req, res) => {
  res.send(`
    <h1>Deposit Approval System</h1>
    <p>Server is running!</p>
    <ul>
      <li><a href="/set-webhook">Setup Webhook</a></li>
      <li>Webhook URL: <code>/webhook</code></li>
      <li>Monitoring Status: ${subscription ? 'Active' : 'Inactive'}</li>
      <li>Pending Notifications: ${notificationQueue.length}</li>
    </ul>
  `);
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Webhook URL: ${process.env.RAILWAY_PUBLIC_DOMAIN || `http://localhost:${PORT}`}/webhook`);
  
  // Auto-start monitoring if in production
  if (process.env.NODE_ENV === 'production') {
    startDepositMonitoring();
  }
});
