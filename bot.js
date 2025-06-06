const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// Environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const VERCEL_URL = process.env.VERCEL_URL;

// Initialize Supabase with connection pooling
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  db: { schema: 'public' }
});

// Cache for frequently accessed data
const userCache = new Map();
const transactionCache = new Map();

// NEW FEATURE: Transaction status tracking
const transactionStatus = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  PROCESSING: 'processing'
};

// NEW FEATURE: Enhanced error handling
class BotError extends Error {
  constructor(message, userFriendlyMessage) {
    super(message);
    this.userFriendlyMessage = userFriendlyMessage;
  }
}

// Optimized for Vercel: Remove background tasks and use Supabase triggers
app.get('/set-webhook', async (req, res) => {
  try {
    const webhookUrl = `${VERCEL_URL}/webhook`;
    const response = await axios.get(
      `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${webhookUrl}`
    );
    
    res.send({
      success: true,
      ...response.data,
      webhook_url: webhookUrl,
      note: 'Background monitoring is handled via Supabase triggers'
    });
  } catch (error) {
    console.error('Webhook setup failed:', error);
    sendErrorToAdmin(`Webhook setup failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// NEW FEATURE: Check pending deposits on demand
app.get('/check-pending', async (req, res) => {
  try {
    const count = await backfillPendingDeposits();
    res.json({ pendingDeposits: count });
  } catch (error) {
    console.error('Pending check failed:', error);
    res.status(500).json({ error: error.message });
  }
});

// Optimized deposit notification with caching
async function sendDepositNotification(deposit) {
  try {
    // Check cache first
    const cachedUser = userCache.get(deposit.player_phone);
    let userInfo = cachedUser || '';

    if (!cachedUser) {
      const { data: user } = await supabase
        .from('users')
        .select('name, balance')
        .eq('phone', deposit.player_phone)
        .single();
      
      if (user) {
        userInfo = `👤 *Name:* ${user.name}\n💰 *Current Balance:* ${user.balance.toFixed(2)} ETB\n`;
        userCache.set(deposit.player_phone, userInfo);
      }
    }

    const message = `💰 *New Deposit Request* 💰\n\n` +
                   `🆔 *ID:* ${deposit.id}\n` +
                   `📱 *Phone:* ${deposit.player_phone}\n` +
                   userInfo +
                   `💵 *Amount:* ${deposit.amount.toFixed(2)} ETB\n` +
                   `📅 *Date:* ${new Date(deposit.created_at).toLocaleString()}\n` +
                   `📝 *Description:* ${deposit.description || 'None'}\n\n` +
                   `_Please review this deposit request_`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `approve_${deposit.id}` },
          { text: "❌ Reject", callback_data: `reject_${deposit.id}` }
        ],
        [
          { text: "📝 View History", callback_data: `history_${deposit.player_phone}` },
          { text: "🔄 Refresh", callback_data: `refresh_${deposit.id}` }
        ]
      ]
    };

    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id: ADMIN_CHAT_ID,
        text: message,
        parse_mode: 'Markdown',
        reply_markup: keyboard
      }
    );
  } catch (error) {
    console.error('Notification failed:', error);
    throw error;
  }
}

// NEW FEATURE: Refresh transaction data
async function refreshTransaction(transactionId) {
  try {
    const { data: transaction, error } = await supabase
      .from('player_transactions')
      .select('*')
      .eq('id', transactionId)
      .single();

    if (error) throw error;
    return transaction;
  } catch (error) {
    console.error('Refresh failed:', error);
    throw new BotError(error.message, "Failed to refresh transaction data");
  }
}

// Optimized transaction history with pagination
async function getTransactionHistory(phone, limit = 5, offset = 0) {
  const cacheKey = `${phone}-${limit}-${offset}`;
  const cached = transactionCache.get(cacheKey);
  
  if (cached) {
    return cached;
  }

  try {
    const { data: transactions, error } = await supabase
      .from('player_transactions')
      .select('*')
      .eq('player_phone', phone)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

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

    // Add pagination controls if more records exist
    const { count } = await supabase
      .from('player_transactions')
      .select('*', { count: 'exact', head: true })
      .eq('player_phone', phone);

    if (count > offset + limit) {
      message += `\n*Showing ${offset + 1}-${Math.min(offset + limit, count)} of ${count} transactions*`;
    }

    transactionCache.set(cacheKey, message);
    return message;
  } catch (error) {
    console.error('History error:', error);
    throw new BotError(error.message, "Failed to load transaction history");
  }
}

// NEW FEATURE: Error notification to admin
async function sendErrorToAdmin(errorMessage) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id: ADMIN_CHAT_ID,
        text: `❌ *Bot Error* ❌\n\n${errorMessage}`,
        parse_mode: 'Markdown'
      }
    );
  } catch (error) {
    console.error('Failed to send error notification:', error);
  }
}

// Optimized backfill function
async function backfillPendingDeposits() {
  try {
    const { data: deposits, error } = await supabase
      .from('player_transactions')
      .select('*')
      .eq('status', transactionStatus.PENDING)
      .eq('transaction_type', 'deposit')
      .order('created_at', { ascending: false });

    if (error) throw error;

    console.log(`Processing ${deposits.length} pending deposits`);
    await Promise.all(deposits.map(deposit => sendDepositNotification(deposit)));
    
    return deposits.length;
  } catch (error) {
    console.error('Backfill error:', error);
    sendErrorToAdmin(`Backfill failed: ${error.message}`);
    throw error;
  }
}

// Health check endpoint
app.get('/', (req, res) => {
  res.send(`
    <h1>Deposit Approval System</h1>
    <p>Server is running on Vercel!</p>
    <ul>
      <li><a href="/set-webhook">Setup Webhook</a></li>
      <li><a href="/check-pending">Check Pending Deposits</a></li>
      <li>Webhook URL: <code>/webhook</code></li>
      <li>User Cache Size: ${userCache.size}</li>
      <li>Transaction Cache Size: ${transactionCache.size}</li>
    </ul>
  `);
});

// Optimized webhook handler
app.post('/webhook', async (req, res) => {
  try {
    const update = req.body;
    
    if (!update.callback_query) {
      return res.send('OK');
    }

    const callbackQuery = update.callback_query;
    const [action, identifier] = callbackQuery.data.split('_');
    
    // Handle different actions
    switch (action) {
      case 'approve':
      case 'reject':
        await handleTransactionAction(action, identifier, callbackQuery);
        break;
        
      case 'history':
        await handleHistoryAction(identifier, callbackQuery);
        break;
        
      case 'refresh':
        await handleRefreshAction(identifier, callbackQuery);
        break;
        
      default:
        console.log(`Unknown action: ${action}`);
    }
    
    res.send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Error processing request');
  }
});

// NEW FEATURE: Dedicated action handlers
async function handleTransactionAction(action, transactionId, callbackQuery) {
  try {
    if (transactionCache.has(`processing_${transactionId}`)) {
      await answerCallback(callbackQuery.id, 'Transaction is already being processed!', true);
      return;
    }

    transactionCache.set(`processing_${transactionId}`, true);
    
    const status = action === 'approve' ? transactionStatus.APPROVED : transactionStatus.REJECTED;
    const { currentTx, newBalance } = await processTransaction(transactionId, status);
    
    const newMessage = `${callbackQuery.message.text}\n\n` +
                     `✅ *Status:* ${status.toUpperCase()}\n` +
                     `⏱ *Processed At:* ${new Date().toLocaleString()}\n` +
                     (action === 'approve' ? 
                      `💰 *New Balance:* ${newBalance.toFixed(2)} ETB` : '');

    await editMessage(
      callbackQuery.message.chat.id,
      callbackQuery.message.message_id,
      newMessage
    );
    
    await answerCallback(callbackQuery.id, `Transaction ${status} successfully!`);
    
    // Clear caches
    userCache.delete(currentTx.player_phone);
    transactionCache.clear();
  } catch (error) {
    console.error('Transaction action failed:', error);
    await handleTransactionError(error, callbackQuery);
  } finally {
    transactionCache.delete(`processing_${transactionId}`);
  }
}

async function processTransaction(transactionId, status) {
  // 1. Verify transaction status
  const { data: currentTx, error: txError } = await supabase
    .from('player_transactions')
    .select('status, player_phone, amount')
    .eq('id', transactionId)
    .single();

  if (txError || !currentTx) {
    throw new BotError(txError?.message || 'Transaction not found', 'Transaction lookup failed');
  }

  if (currentTx.status !== transactionStatus.PENDING) {
    throw new BotError(
      `Transaction already ${currentTx.status}`,
      `Transaction already ${currentTx.status}`
    );
  }

  // 2. Update transaction
  const { error: updateError } = await supabase
    .from('player_transactions')
    .update({ 
      status,
      processed_at: new Date().toISOString(),
      processed_by: 'Telegram Bot'
    })
    .eq('id', transactionId);

  if (updateError) {
    throw new BotError(updateError.message, 'Failed to update transaction');
  }

  // 3. Update balance if approved
  let newBalance = null;
  if (status === transactionStatus.APPROVED) {
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('balance')
      .eq('phone', currentTx.player_phone)
      .single();

    if (userError) {
      throw new BotError(userError.message, 'Failed to get user balance');
    }

    newBalance = (user?.balance || 0) + currentTx.amount;
    
    const { error: balanceError } = await supabase
      .from('users')
      .update({ balance: newBalance })
      .eq('phone', currentTx.player_phone);

    if (balanceError) {
      throw new BotError(balanceError.message, 'Failed to update balance');
    }
  }

  return { currentTx, newBalance };
}

async function handleHistoryAction(phone, callbackQuery) {
  try {
    const history = await getTransactionHistory(phone);
    
    await answerCallback(
      callbackQuery.id,
      `Showing last 5 transactions for ${phone}`,
      true
    );
    
    await sendMessage(
      ADMIN_CHAT_ID,
      history,
      'Markdown',
      {
        inline_keyboard: [
          [{ text: "⬅️ Back", callback_data: `back_${phone}` }]
        ]
      }
    );
  } catch (error) {
    console.error('History action failed:', error);
    await handleHistoryError(error, callbackQuery);
  }
}

async function handleRefreshAction(transactionId, callbackQuery) {
  try {
    const transaction = await refreshTransaction(transactionId);
    await sendDepositNotification(transaction);
    await answerCallback(callbackQuery.id, 'Transaction refreshed!');
  } catch (error) {
    console.error('Refresh action failed:', error);
    await answerCallback(
      callbackQuery.id,
      error.userFriendlyMessage || 'Refresh failed',
      true
    );
  }
}

// Helper functions for Telegram API
async function answerCallback(queryId, text, showAlert = false) {
  await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    callback_query_id: queryId,
    text,
    show_alert: showAlert
  });
}

async function editMessage(chatId, messageId, text, parseMode = 'Markdown') {
  await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: parseMode,
    reply_markup: { inline_keyboard: [] }
  });
}

async function sendMessage(chatId, text, parseMode = 'Markdown', replyMarkup = null) {
  await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
    reply_markup: replyMarkup
  });
}

// Error handlers
async function handleTransactionError(error, callbackQuery) {
  await sendErrorToAdmin(`Transaction processing failed: ${error.message}`);
  
  await answerCallback(
    callbackQuery.id,
    error.userFriendlyMessage || 'Transaction processing failed',
    true
  );
}

async function handleHistoryError(error, callbackQuery) {
  await sendErrorToAdmin(`History request failed: ${error.message}`);
  
  await answerCallback(
    callbackQuery.id,
    error.userFriendlyMessage || 'Failed to load history',
    true
  );
}

// Vercel needs this export
module.exports = app;
