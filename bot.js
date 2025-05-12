require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

const app = express();
app.use(express.json());

// Configuration
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://evberyanshxxalxtwnnc.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'your-supabase-key';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '7971577643:AAFcL38ZrahWxEyyIcz3dO4aC9yq9LTAD5M';
const ADMIN_CHAT_IDS = process.env.ADMIN_CHAT_IDS ? process.env.ADMIN_CHAT_IDS.split(',') : [];
const TIMEZONE = process.env.TIMEZONE || 'Africa/Addis_Ababa';

// Initialize clients
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// State management
const pendingActions = new Map(); // Track pending actions
const userSessions = new Map();   // Track admin sessions
const notificationQueue = [];     // Queue for rate limiting
let isProcessingQueue = false;

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  initializeSystems();
});

// Initialize all systems
function initializeSystems() {
  setupRealtimeMonitoring();
  setupScheduledJobs();
  if (process.env.NODE_ENV === 'production') {
    setupWebhook();
  }
}

// ====================
// CORE FUNCTIONALITY
// ====================

// Realtime monitoring setup
function setupRealtimeMonitoring() {
  const channel = supabase
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
          notifyAdmins(payload.new);
        }
      }
    )
    .subscribe();

  console.log('Realtime monitoring active');
  return channel;
}

// Notify all admins about new deposit
async function notifyAdmins(deposit) {
  for (const chatId of ADMIN_CHAT_IDS) {
    try {
      const message = formatDepositMessage(deposit);
      const response = await sendTelegramMessage(chatId, message, deposit.id);
      
      // Store message ID for future reference
      await supabase
        .from('telegram_messages')
        .upsert({
          transaction_id: deposit.id,
          chat_id: chatId,
          message_id: response.message_id,
          created_at: new Date().toISOString()
        });
    } catch (error) {
      console.error(`Error notifying admin ${chatId}:`, error);
    }
  }
}

// Format deposit message with action buttons
function formatDepositMessage(deposit) {
  return `💰 *New Deposit Request* 💰\n\n` +
         `🆔 *ID:* ${deposit.id}\n` +
         `📱 *Phone:* ${deposit.player_phone}\n` +
         `💵 *Amount:* ${deposit.amount.toFixed(2)} ETB\n` +
         `📅 *Date:* ${new Date(deposit.created_at).toLocaleString('en-US', { timeZone: TIMEZONE })}\n` +
         `📝 *Description:* ${deposit.description || 'None provided'}\n\n` +
         `_Please review this deposit request_`;
}

// ====================
// ACTION HANDLERS
// ====================

// Webhook handler for all Telegram updates
app.post('/webhook', async (req, res) => {
  try {
    const update = req.body;
    
    // Handle callback queries (button clicks)
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    }
    // Handle text messages (rejection reasons)
    else if (update.message && update.message.reply_to_message) {
      await handleAdminReply(update.message);
    }
    // Handle admin commands
    else if (update.message && update.message.text && update.message.text.startsWith('/')) {
      await handleAdminCommand(update.message);
    }
    
    res.send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Error processing request');
  }
});

// Handle button clicks
async function handleCallbackQuery(callbackQuery) {
  const [action, txId] = callbackQuery.data.split('_');
  const chatId = callbackQuery.message.chat.id;
  const admin = ADMIN_CHAT_IDS.includes(chatId.toString()) ? chatId.toString() : null;

  if (!admin) {
    return await sendTelegramMessage(chatId, "❌ You're not authorized to perform this action");
  }

  if (action === 'approve') {
    await handleApproval(txId, callbackQuery, admin);
  } 
  else if (action === 'reject') {
    await requestRejectionReason(txId, callbackQuery, admin);
  }
  else if (action === 'details') {
    await showTransactionDetails(txId, callbackQuery.message.chat.id);
  }
}

// Handle admin text replies (rejection reasons)
async function handleAdminReply(message) {
  const chatId = message.chat.id;
  const originalMessageId = message.reply_to_message.message_id;
  
  // Check if this is a pending rejection
  const pendingKey = `${chatId}_${originalMessageId}`;
  if (pendingActions.has(pendingKey)) {
    const { txId, admin } = pendingActions.get(pendingKey);
    await completeRejection(txId, message.text, chatId, admin);
    pendingActions.delete(pendingKey);
  }
}

// Handle admin commands
async function handleAdminCommand(message) {
  const chatId = message.chat.id;
  const [command, ...args] = message.text.split(' ');

  switch (command.toLowerCase()) {
    case '/stats':
      await sendStatsReport(chatId);
      break;
    case '/pending':
      await sendPendingDeposits(chatId);
      break;
    case '/help':
      await sendHelpMessage(chatId);
      break;
    default:
      await sendTelegramMessage(chatId, "❌ Unknown command. Type /help for available commands");
  }
}

// ====================
// ACTION IMPLEMENTATIONS
// ====================

// Handle deposit approval
async function handleApproval(txId, callbackQuery, admin) {
  try {
    // Get transaction details
    const { data: tx, error } = await supabase
      .from('player_transactions')
      .select('*')
      .eq('id', txId)
      .single();

    if (error || !tx) throw new Error('Transaction not found');

    // Update user balance
    await updateUserBalance(tx.player_phone, tx.amount);

    // Update transaction status
    await supabase
      .from('player_transactions')
      .update({ 
        status: 'approved',
        processed_at: new Date().toISOString(),
        processed_by: `Telegram Admin: ${admin}`,
        description: 'Deposit approved via Telegram'
      })
      .eq('id', txId);

    // Log the action
    await logAdminAction({
      admin_id: admin,
      action: 'approve',
      transaction_id: txId,
      details: `Approved deposit of ${tx.amount} ETB`
    });

    // Update all notification messages
    await updateAllTransactionMessages(txId, 'APPROVED ✅', admin);

    // Send confirmation
    await answerCallbackQuery(callbackQuery.id, 'Deposit approved successfully!');
    
    console.log(`Deposit ${txId} approved by ${admin}`);
  } catch (error) {
    console.error('Approval error:', error);
    await answerCallbackQuery(callbackQuery.id, '❌ Failed to approve deposit');
    await sendTelegramMessage(callbackQuery.message.chat.id, `Error: ${error.message}`);
  }
}

// Request rejection reason from admin
async function requestRejectionReason(txId, callbackQuery, admin) {
  // Store pending action
  const pendingKey = `${callbackQuery.message.chat.id}_${callbackQuery.message.message_id}`;
  pendingActions.set(pendingKey, { txId, admin });

  // Ask for reason
  await sendTelegramMessage(
    callbackQuery.message.chat.id,
    'Please enter the reason for rejecting this deposit:',
    {
      reply_to_message_id: callbackQuery.message.message_id,
      reply_markup: { force_reply: true }
    }
  );

  await answerCallbackQuery(callbackQuery.id, 'Please provide a rejection reason');
}

// Complete rejection with reason
async function completeRejection(txId, reason, chatId, admin) {
  if (!reason || reason.trim().length < 3) {
    return await sendTelegramMessage(chatId, 'Rejection cancelled - reason too short or not provided');
  }

  try {
    // Update transaction
    await supabase
      .from('player_transactions')
      .update({ 
        status: 'rejected',
        processed_at: new Date().toISOString(),
        processed_by: `Telegram Admin: ${admin}`,
        reject_reason: reason,
        description: `Deposit rejected: ${reason}`
      })
      .eq('id', txId);

    // Log the action
    await logAdminAction({
      admin_id: admin,
      action: 'reject',
      transaction_id: txId,
      details: `Rejected deposit: ${reason}`
    });

    // Update all notification messages
    await updateAllTransactionMessages(txId, `REJECTED ❌\nReason: ${reason}`, admin);

    console.log(`Deposit ${txId} rejected by ${admin} with reason: ${reason}`);
  } catch (error) {
    console.error('Rejection error:', error);
    await sendTelegramMessage(chatId, `❌ Failed to reject deposit: ${error.message}`);
  }
}

// Show transaction details
async function showTransactionDetails(txId, chatId) {
  try {
    const { data: tx, error } = await supabase
      .from('player_transactions')
      .select('*')
      .eq('id', txId)
      .single();

    if (error || !tx) throw new Error('Transaction not found');

    const details = `🔍 *Transaction Details*\n\n` +
                   `🆔 ID: ${tx.id}\n` +
                   `📱 Phone: ${tx.player_phone}\n` +
                   `💵 Amount: ${tx.amount.toFixed(2)} ETB\n` +
                   `📅 Created: ${new Date(tx.created_at).toLocaleString('en-US', { timeZone: TIMEZONE })}\n` +
                   `🔄 Status: ${tx.status.toUpperCase()}\n` +
                   `📝 Description: ${tx.description || 'None'}`;

    await sendTelegramMessage(chatId, details);
  } catch (error) {
    await sendTelegramMessage(chatId, `❌ Error: ${error.message}`);
  }
}

// ====================
// SCHEDULED JOBS
// ====================

function setupScheduledJobs() {
  // Daily summary at 9 AM
  cron.schedule('0 9 * * *', () => {
    ADMIN_CHAT_IDS.forEach(chatId => {
      sendDailyReport(chatId).catch(console.error);
    });
  }, {
    scheduled: true,
    timezone: TIMEZONE
  });

  // Hourly pending deposits reminder
  cron.schedule('0 * * * *', () => {
    checkPendingDeposits().catch(console.error);
  }, {
    scheduled: true,
    timezone: TIMEZONE
  });

  console.log('Scheduled jobs initialized');
}

// Send daily report
async function sendDailyReport(chatId) {
  try {
    const now = new Date();
    const startDate = new Date(now.setDate(now.getDate() - 1)).toISOString();
    
    const { data: stats } = await supabase
      .from('player_transactions')
      .select('status, amount')
      .gte('created_at', startDate)
      .eq('transaction_type', 'deposit');

    const approved = stats.filter(t => t.status === 'approved').reduce((sum, t) => sum + t.amount, 0);
    const rejected = stats.filter(t => t.status === 'rejected').reduce((sum, t) => sum + t.amount, 0);
    const pending = stats.filter(t => t.status === 'pending').reduce((sum, t) => sum + t.amount, 0);

    const report = `📊 *Daily Deposit Report*\n\n` +
                  `📅 ${new Date().toLocaleDateString('en-US', { timeZone: TIMEZONE })}\n\n` +
                  `✅ Approved: ${approved.toFixed(2)} ETB\n` +
                  `❌ Rejected: ${rejected.toFixed(2)} ETB\n` +
                  `🔄 Pending: ${pending.toFixed(2)} ETB\n\n` +
                  `_Have a productive day!_`;

    await sendTelegramMessage(chatId, report);
  } catch (error) {
    console.error('Error sending daily report:', error);
  }
}

// Check for pending deposits
async function checkPendingDeposits() {
  try {
    const { data: pending } = await supabase
      .from('player_transactions')
      .select('*')
      .eq('status', 'pending')
      .eq('transaction_type', 'deposit')
      .order('created_at', { ascending: true });

    if (pending.length > 0) {
      const totalPending = pending.reduce((sum, t) => sum + t.amount, 0);
      const oldestPending = pending[0];
      const hoursPending = Math.floor((new Date() - new Date(oldestPending.created_at)) / (1000 * 60 * 60));

      if (hoursPending >= 1) { // Only notify if pending for more than 1 hour
        const reminder = `⏰ *Pending Deposits Reminder*\n\n` +
                        `You have ${pending.length} pending deposits (${totalPending.toFixed(2)} ETB)\n` +
                        `Oldest pending for ${hoursPending.toFixed(1)} hours\n\n` +
                        `_Please review them soon_`;

        for (const chatId of ADMIN_CHAT_IDS) {
          await sendTelegramMessage(chatId, reminder);
        }
      }
    }
  } catch (error) {
    console.error('Error checking pending deposits:', error);
  }
}

// ====================
// HELPER FUNCTIONS
// ====================

// Update user balance
async function updateUserBalance(phone, amount) {
  const { data: user } = await supabase
    .from('users')
    .select('balance')
    .eq('phone', phone)
    .single();

  const newBalance = (user?.balance || 0) + amount;

  await supabase
    .from('users')
    .update({ balance: newBalance })
    .eq('phone', phone);
}

// Update all messages for a transaction
async function updateAllTransactionMessages(txId, statusText, admin) {
  try {
    const { data: messages } = await supabase
      .from('telegram_messages')
      .select('*')
      .eq('transaction_id', txId);

    for (const msg of messages) {
      try {
        const originalMessage = await getChatMessage(msg.chat_id, msg.message_id);
        if (originalMessage) {
          await editMessageText(
            msg.chat_id,
            msg.message_id,
            `${originalMessage.text}\n\nStatus: ${statusText}\nProcessed by: ${admin}`,
            { inline_keyboard: [] } // Remove buttons
          );
        }
      } catch (error) {
        console.error(`Error updating message ${msg.message_id}:`, error);
      }
    }
  } catch (error) {
    console.error('Error updating transaction messages:', error);
  }
}

// Log admin actions
async function logAdminAction({ admin_id, action, transaction_id, details }) {
  await supabase
    .from('admin_actions')
    .insert({
      admin_id,
      action,
      transaction_id,
      details,
      performed_at: new Date().toISOString()
    });
}

// ====================
// TELEGRAM API WRAPPERS
// ====================

async function sendTelegramMessage(chatId, text, options = {}) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    ...options
  };

  const response = await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    payload
  );

  return response.data.result;
}

async function editMessageText(chatId, messageId, text, replyMarkup) {
  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`,
    {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'Markdown',
      reply_markup: replyMarkup
    }
  );
}

async function answerCallbackQuery(callbackQueryId, text) {
  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
    {
      callback_query_id: callbackQueryId,
      text,
      show_alert: true
    }
  );
}

async function getChatMessage(chatId, messageId) {
  try {
    const updates = await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`
    );
    return updates.data.result
      .map(u => u.message || u.edited_message)
      .find(m => m && m.chat.id.toString() === chatId.toString() && m.message_id === messageId);
  } catch (error) {
    console.error('Error getting chat message:', error);
    return null;
  }
}

// ====================
// ADMIN COMMANDS
// ====================

async function sendStatsReport(chatId) {
  try {
    const now = new Date();
    const startOfDay = new Date(now.setHours(0, 0, 0, 0)).toISOString();
    
    const { data: stats } = await supabase
      .from('player_transactions')
      .select('status, amount')
      .gte('created_at', startOfDay)
      .eq('transaction_type', 'deposit');

    const approved = stats.filter(t => t.status === 'approved').reduce((sum, t) => sum + t.amount, 0);
    const rejected = stats.filter(t => t.status === 'rejected').reduce((sum, t) => sum + t.amount, 0);
    const pending = stats.filter(t => t.status === 'pending').reduce((sum, t) => sum + t.amount, 0);

    const report = `📊 *Current Stats*\n\n` +
                  `✅ Approved: ${approved.toFixed(2)} ETB\n` +
                  `❌ Rejected: ${rejected.toFixed(2)} ETB\n` +
                  `🔄 Pending: ${pending.toFixed(2)} ETB\n\n` +
                  `_Last updated: ${new Date().toLocaleTimeString('en-US', { timeZone: TIMEZONE })}_`;

    await sendTelegramMessage(chatId, report);
  } catch (error) {
    await sendTelegramMessage(chatId, `❌ Error generating stats: ${error.message}`);
  }
}

async function sendPendingDeposits(chatId) {
  try {
    const { data: pending } = await supabase
      .from('player_transactions')
      .select('*')
      .eq('status', 'pending')
      .eq('transaction_type', 'deposit')
      .order('created_at', { ascending: true });

    if (pending.length === 0) {
      return await sendTelegramMessage(chatId, '🎉 No pending deposits!');
    }

    let message = `⏳ *Pending Deposits (${pending.length})*\n\n`;
    pending.slice(0, 5).forEach(tx => {
      const hoursPending = ((new Date() - new Date(tx.created_at)) / (1000 * 60 * 60)).toFixed(1);
      message += `🆔 ${tx.id}\n💵 ${tx.amount.toFixed(2)} ETB\n⏱ ${hoursPending}h ago\n\n`;
    });

    if (pending.length > 5) {
      message += `...and ${pending.length - 5} more`;
    }

    message += `\n_Total pending: ${pending.reduce((sum, t) => sum + t.amount, 0).toFixed(2)} ETB_`;

    await sendTelegramMessage(chatId, message);
  } catch (error) {
    await sendTelegramMessage(chatId, `❌ Error fetching pending deposits: ${error.message}`);
  }
}

async function sendHelpMessage(chatId) {
  const helpText = `🤖 *Deposit Approval Bot Help*\n\n` +
                  `/stats - Show today's deposit statistics\n` +
                  `/pending - List pending deposits\n` +
                  `/help - Show this help message\n\n` +
                  `*How to approve/reject:*\n` +
                  `1. Click "Approve" or "Reject" on deposit notification\n` +
                  `2. For rejections, provide a reason when asked\n\n` +
                  `_Bot version: 2.0_`;

  await sendTelegramMessage(chatId, helpText);
}

// ====================
// SETUP WEBHOOK
// ====================

async function setupWebhook() {
  try {
    const url = `${process.env.RAILWAY_PUBLIC_DOMAIN || process.env.HOST_URL}/webhook`;
    await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${url}`
    );
    console.log(`Webhook configured at ${url}`);
  } catch (error) {
    console.error('Webhook setup failed:', error);
  }
}

// Health check endpoint
app.get('/', (req, res) => {
  res.send(`
    <h1>Deposit Approval System</h1>
    <p>Server is running!</p>
    <ul>
      <li>Version: 2.0</li>
      <li>Admins: ${ADMIN_CHAT_IDS.length}</li>
      <li>Pending Actions: ${pendingActions.size}</li>
      <li>Time: ${new Date().toLocaleString('en-US', { timeZone: TIMEZONE })}</li>
    </ul>
  `);
});
