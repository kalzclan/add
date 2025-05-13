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

// Track processing transactions to prevent duplicates
const processingTransactions = new Set();

// Webhook setup endpoint (unchanged)
app.get('/set-webhook', async (req, res) => {
  try {
    const url = `${process.env.RAILWAY_PUBLIC_DOMAIN || `http://localhost:${PORT}`}/webhook`;
    const response = await axios.get(
      `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${url}`
    );
    
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

// Start monitoring deposits (unchanged)
async function startDepositMonitoring() {
  await backfillPendingDeposits();
  
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

// Process pending deposits queue (unchanged)
let notificationQueue = [];
let isProcessingQueue = false;

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
  if (notificationQueue.length > 0) {
    setTimeout(processNotificationQueue, 500);
  }
}

// Backfill any existing pending deposits (unchanged)
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

// Enhanced Telegram notification with history button
async function sendDepositNotification(deposit) {
  const message = `💰 *New Deposit Request* 💰\n\n` +
                 `🆔 *ID:* ${deposit.id}\n` +
                 `📱 *Phone:* ${deposit.player_phone}\n` +
                 `💵 *Amount:* ${deposit.amount.toFixed(2)} ETB\n` +
                 `📅 *Date:* ${new Date(deposit.created_at).toLocaleString()}\n` +
                 `📝 *Description:* ${deposit.description || 'None'}\n\n` +
                 `_Please review this deposit request_`;

  await axios.post(
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
          ],
          [
            { text: "📝 View History", callback_data: `history_${deposit.player_phone}` }
          ]
        ]
      }
    }
  );
}

// Enhanced webhook handler with duplicate protection
app.post('/webhook', async (req, res) => {
  try {
    const update = req.body;
    
    if (update.callback_query) {
      const [action, identifier] = update.callback_query.data.split('_');
      
      // Handle approve/reject actions
      if (action === 'approve' || action === 'reject') {
        const txId = identifier;
        
        // Prevent duplicate processing
        if (processingTransactions.has(txId)) {
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: update.callback_query.id,
            text: `Transaction is already being processed!`,
            show_alert: true
          });
          return res.send('OK');
        }
        
        processingTransactions.add(txId);
        
        try {
          // Check current status first
          const { data: currentTx, error: txError } = await supabase
            .from('player_transactions')
            .select('status, player_phone, amount')
            .eq('id', txId)
            .single();
            
          if (txError) throw txError;
          if (currentTx.status !== 'pending') {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
              callback_query_id: update.callback_query.id,
              text: `Transaction already ${currentTx.status}!`,
              show_alert: true
            });
            return res.send('OK');
          }
          
          const status = action === 'approve' ? 'approved' : 'rejected';
          let newBalance = null;
          
          // Update transaction status
          const { data: transaction, error: updateError } = await supabase
            .from('player_transactions')
            .update({ 
              status,
              processed_at: new Date().toISOString(),
              processed_by: 'Telegram Bot'
            })
            .eq('id', txId)
            .select()
            .single();
            
          if (updateError) throw updateError;
          
          // Update user balance if approved
          if (action === 'approve') {
            // Get current balance
            const { data: user, error: userError } = await supabase
              .from('users')
              .select('balance')
              .eq('phone', currentTx.player_phone)
              .single();
              
            if (userError) throw userError;
            
            // Calculate new balance
            newBalance = (user?.balance || 0) + currentTx.amount;
            
            // Update balance
            const { error: balanceError } = await supabase
              .from('users')
              .update({ balance: newBalance })
              .eq('phone', currentTx.player_phone);
              
            if (balanceError) throw balanceError;
          }
          
          // Update Telegram message
          const newMessage = `${update.callback_query.message.text}\n\n` +
                           `✅ *Status:* ${status.toUpperCase()}\n` +
                           `⏱ *Processed At:* ${new Date().toLocaleString()}\n` +
                           (action === 'approve' ? 
                            `💰 *New Balance:* ${newBalance.toFixed(2)} ETB` : '');
          
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
            chat_id: update.callback_query.message.chat.id,
            message_id: update.callback_query.message.message_id,
            text: newMessage,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [] }
          });
          
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: update.callback_query.id,
            text: `Transaction ${status} successfully!`,
            show_alert: false
          });
          
        } catch (error) {
          console.error('Error processing transaction:', error);
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            callback_query_id: update.callback_query.id,
            text: `Error processing transaction!`,
            show_alert: true
          });
        } finally {
          processingTransactions.delete(txId);
        }
      }
      // Handle history request
      else if (action === 'history') {
        const phone = identifier;
        const history = await getTransactionHistory(phone);
        
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
          callback_query_id: update.callback_query.id,
          text: `Showing last 5 transactions for ${phone}`,
          show_alert: true
        });
        
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          chat_id: ADMIN_CHAT_ID,
          text: history,
          parse_mode: 'Markdown'
        });
      }
    }
    
    res.send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Error processing request');
  }
});

// Get transaction history for a user
async function getTransactionHistory(phone) {
  const { data: transactions, error } = await supabase
    .from('player_transactions')
    .select('*')
    .eq('player_phone', phone)
    .order('created_at', { ascending: false })
    .limit(5);
    
  if (error) throw error;
  
  let message = `📊 *Transaction History* 📊\n\n` +
               `📱 *Phone:* ${phone}\n\n`;
               
  transactions.forEach(tx => {
    message += `🆔 *ID:* ${tx.id}\n` +
               `💰 *Amount:* ${tx.amount.toFixed(2)} ETB\n` +
               `📌 *Type:* ${tx.transaction_type}\n` +
               `📅 *Date:* ${new Date(tx.created_at).toLocaleString()}\n` +
               `✅ *Status:* ${tx.status}\n` +
               `----------------------------\n`;
  });
  
  return message;
}

// Health check endpoint (unchanged)
app.get('/', (req, res) => {
  res.send(`
    <h1>Deposit Approval System</h1>
    <p>Server is running!</p>
    <ul>
      <li><a href="/set-webhook">Setup Webhook</a></li>
      <li>Webhook URL: <code>/webhook</code></li>
      <li>Monitoring Status: ${subscription ? 'Active' : 'Inactive'}</li>
      <li>Pending Notifications: ${notificationQueue.length}</li>
      <li>Processing Transactions: ${processingTransactions.size}</li>
    </ul>
  `);
});

// Start server (unchanged)
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Webhook URL: ${process.env.RAILWAY_PUBLIC_DOMAIN || `http://localhost:${PORT}`}/webhook`);
  
  if (process.env.NODE_ENV === 'production') {
    startDepositMonitoring();
  }
});
