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
            console.log(`Transaction ${txId} is already being processed`);
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
              callback_query_id: update.callback_query.id,
              text: `Transaction is already being processed!`,
              show_alert: true
            });
            return res.send('OK');
          }
          
          processingTransactions.add(txId);
          console.log(`Processing transaction ${txId} (${action})`);
          
          try {
            // 1. Check current transaction status
            console.log(`Checking current status for transaction ${txId}`);
            const { data: currentTx, error: txError } = await supabase
              .from('player_transactions')
              .select('status, player_phone, amount')
              .eq('id', txId)
              .single();
              
            if (txError || !currentTx) {
              console.error('Transaction lookup failed:', txError?.message || 'Transaction not found');
              throw new Error(txError?.message || 'Transaction not found');
            }
            
            if (currentTx.status !== 'pending') {
              console.log(`Transaction ${txId} already ${currentTx.status}`);
              await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
                callback_query_id: update.callback_query.id,
                text: `Transaction already ${currentTx.status}!`,
                show_alert: true
              });
              return res.send('OK');
            }
            
            const status = action === 'approve' ? 'approved' : 'rejected';
            let newBalance = null;
            
            // 2. Update transaction status
            console.log(`Updating status for transaction ${txId} to ${status}`);
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
              
            if (updateError || !transaction) {
              console.error('Transaction update failed:', updateError?.message || 'No data returned');
              throw new Error(updateError?.message || 'Transaction update failed');
            }
            
            // 3. Update user balance if approved
            if (action === 'approve') {
              console.log(`Updating balance for user ${currentTx.player_phone}`);
              
              // Get current balance
              const { data: user, error: userError } = await supabase
                .from('users')
                .select('balance')
                .eq('phone', currentTx.player_phone)
                .single();
                
              if (userError) {
                console.error('User lookup failed:', userError.message);
                throw userError;
              }
              
              // Calculate new balance
              newBalance = (user?.balance || 0) + currentTx.amount;
              console.log(`New balance will be ${newBalance} (was ${user?.balance || 0})`);
              
              // Update balance
              const { error: balanceError } = await supabase
                .from('users')
                .update({ balance: newBalance })
                .eq('phone', currentTx.player_phone);
                
              if (balanceError) {
                console.error('Balance update failed:', balanceError.message);
                throw balanceError;
              }
            }
            
            // 4. Update Telegram message
            console.log(`Updating Telegram message for transaction ${txId}`);
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
            
            // 5. Send success response
            console.log(`Transaction ${txId} processed successfully`);
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
              callback_query_id: update.callback_query.id,
              text: `Transaction ${status} successfully!`,
              show_alert: false
            });
            
          } catch (error) {
            console.error('Error processing transaction:', error.message);
            console.error(error.stack);
            
            // Try to send error details to admin
            try {
              await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: ADMIN_CHAT_ID,
                text: `❌ Error processing transaction ${txId}:\n\n<code>${error.message}</code>`,
                parse_mode: 'HTML'
              });
            } catch (tgError) {
              console.error('Failed to send error to Telegram:', tgError);
            }
            
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
              callback_query_id: update.callback_query.id,
              text: `Error: ${error.message.substring(0, 50)}...`,
              show_alert: true
            });
          } finally {
            processingTransactions.delete(txId);
          }
        }
        // Handle history request
        else if (action === 'history') {
          const phone = identifier;
          console.log(`Fetching history for ${phone}`);
          
          try {
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
          } catch (error) {
            console.error('Error fetching history:', error);
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
              callback_query_id: update.callback_query.id,
              text: `Error loading history!`,
              show_alert: true
            });
          }
        }
      }
      
      res.send('OK');
    } catch (error) {
      console.error('Webhook processing error:', error.message);
      console.error(error.stack);
      res.status(500).send('Error processing request');
    }
  });
