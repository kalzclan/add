// Remove the node-cron import at the top
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const rateLimit = require('express-rate-limit');
const moment = require('moment');

// ... (keep all other code the same until the scheduleDailyReport function)

// Replace the scheduleDailyReport function with this:
function scheduleDailyReport() {
  console.log('Daily report scheduling is disabled in this version');
  // Alternative: You could implement a simple timeout-based scheduler
  // setInterval(() => handleStatsCommand(ADMIN_CHAT_ID), 24 * 60 * 60 * 1000);
}

// ... (keep all other code the same)

const app = express();
app.use(express.json());

// Environment variables
const BOT_TOKEN = process.env.BOT_TOKEN || 'your_bot_token';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL || 'your_supabase_url';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'your_supabase_key';
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Initialize Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later'
});
app.use(limiter);

// State management
let subscription;
let notificationQueue = [];
let isProcessingQueue = false;
let botCommands = [];

// Enhanced bot commands
const setupBotCommands = async () => {
  botCommands = [
    {
      command: 'start',
      description: 'Start using the bot',
      handler: handleStartCommand
    },
    {
      command: 'help',
      description: 'Show help information',
      handler: handleHelpCommand
    },
    {
      command: 'stats',
      description: 'Get system statistics',
      handler: handleStatsCommand,
      adminOnly: true
    },
    {
      command: 'pending',
      description: 'Get pending deposits',
      handler: handlePendingCommand,
      adminOnly: true
    },
    {
      command: 'player',
      description: 'Get player transaction history',
      handler: handlePlayerCommand,
      adminOnly: true
    },
    {
      command: 'recent',
      description: 'Get recent transactions',
      handler: handleRecentCommand,
      adminOnly: true
    },
    {
      command: 'summary',
      description: 'Get daily summary',
      handler: handleSummaryCommand,
      adminOnly: true
    }
  ];

  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands`, {
      commands: botCommands.map(cmd => ({
        command: cmd.command,
        description: cmd.description
      }))
    });
    console.log('Bot commands registered');
  } catch (error) {
    console.error('Failed to register commands:', error.message);
  }
};

// New command: Player transaction history
async function handlePlayerCommand(chatId, message) {
  const phone = message.text.split(' ')[1];
  if (!phone) {
    return sendTelegramMessage(chatId, 'Please provide a phone number: /player 0912345678');
  }

  try {
    const { data: transactions, error } = await supabase
      .from('player_transactions')
      .select('*')
      .eq('player_phone', phone)
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) throw error;

    if (transactions.length === 0) {
      return sendTelegramMessage(chatId, `No transactions found for ${phone}`);
    }

    let messageText = `📊 Transactions for ${phone}:\n\n`;
    transactions.forEach(tx => {
      messageText += `🆔 ${tx.id}\n` +
                     `💰 ${tx.amount} ETB (${tx.transaction_type})\n` +
                     `📅 ${moment(tx.created_at).format('MMM D, YYYY HH:mm')}\n` +
                     `🔄 Status: ${tx.status}\n` +
                     `🎮 Game: ${tx.game_id || 'N/A'}\n` +
                     `---\n`;
    });

    await sendTelegramMessage(chatId, messageText);
  } catch (error) {
    console.error('Player command error:', error);
    await sendTelegramMessage(chatId, '❌ Error fetching player transactions');
  }
}

// New command: Recent transactions
async function handleRecentCommand(chatId) {
  try {
    const { data: transactions, error } = await supabase
      .from('player_transactions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(5);

    if (error) throw error;

    let messageText = '⏳ Recent Transactions:\n\n';
    transactions.forEach(tx => {
      messageText += `📱 ${tx.player_phone}\n` +
                     `💰 ${tx.amount} ETB (${tx.transaction_type})\n` +
                     `📅 ${moment(tx.created_at).format('MMM D, HH:mm')}\n` +
                     `---\n`;
    });

    await sendTelegramMessage(chatId, messageText);
  } catch (error) {
    console.error('Recent command error:', error);
    await sendTelegramMessage(chatId, '❌ Error fetching recent transactions');
  }
}

// New command: Daily summary
async function handleSummaryCommand(chatId) {
  try {
    const today = moment().startOf('day').toISOString();
    const tomorrow = moment().endOf('day').toISOString();

    const { data: deposits, error: depositError } = await supabase
      .from('player_transactions')
      .select('amount')
      .eq('transaction_type', 'deposit')
      .eq('status', 'approved')
      .gte('created_at', today)
      .lte('created_at', tomorrow);

    const { data: withdrawals, error: withdrawalError } = await supabase
      .from('player_transactions')
      .select('amount')
      .eq('transaction_type', 'withdrawal')
      .eq('status', 'approved')
      .gte('created_at', today)
      .lte('created_at', tomorrow);

    if (depositError || withdrawalError) throw depositError || withdrawalError;

    const totalDeposits = deposits.reduce((sum, tx) => sum + tx.amount, 0);
    const totalWithdrawals = withdrawals.reduce((sum, tx) => sum + tx.amount, 0);
    const netFlow = totalDeposits - totalWithdrawals;

    const message = `📈 Daily Summary (${moment().format('MMM D, YYYY')})\n\n` +
                   `⬆️ Total Deposits: ${totalDeposits.toFixed(2)} ETB\n` +
                   `⬇️ Total Withdrawals: ${totalWithdrawals.toFixed(2)} ETB\n` +
                   `🔀 Net Flow: ${netFlow.toFixed(2)} ETB\n` +
                   `💵 Approx. Revenue: ${(totalDeposits * 0.1).toFixed(2)} ETB`;

    await sendTelegramMessage(chatId, message);
  } catch (error) {
    console.error('Summary command error:', error);
    await sendTelegramMessage(chatId, '❌ Error generating daily summary');
  }
}

// Enhanced deposit notification with game info
async function sendDepositNotification(deposit) {
  const message = `💰 *New Deposit Request* 💰\n\n` +
                 `🆔 *ID:* ${deposit.id}\n` +
                 `📱 *Phone:* ${deposit.player_phone}\n` +
                 `💵 *Amount:* ${deposit.amount.toFixed(2)} ETB\n` +
                 `🎮 *Game:* ${deposit.game_id || 'N/A'}\n` +
                 `📅 *Date:* ${moment(deposit.created_at).format('MMM D, HH:mm')}\n` +
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
            { text: "❌ Reject", callback_data: `reject_${deposit.id}` },
            { text: "📊 Stats", callback_data: `stats_${deposit.player_phone}` }
          ]
        ]
      }
    }
  );

  console.log(`Notification sent for deposit ${deposit.id}`);
  return response.data;
}

// Enhanced callback query handler
async function handleCallbackQuery(callbackQuery) {
  const [action, data] = callbackQuery.data.split('_');
  const chatId = callbackQuery.message.chat.id;

  if (action === 'stats') {
    return handlePlayerStats(chatId, data, callbackQuery);
  }

  // Existing approve/reject logic...
}

// New handler for player stats
async function handlePlayerStats(chatId, phone, callbackQuery) {
  try {
    const { data: transactions, error } = await supabase
      .from('player_transactions')
      .select('*')
      .eq('player_phone', phone)
      .order('created_at', { ascending: false })
      .limit(5);

    if (error) throw error;

    let messageText = `📊 Player Stats (${phone}):\n\n`;
    const depositStats = calculateTransactionStats(transactions, 'deposit');
    const withdrawalStats = calculateTransactionStats(transactions, 'withdrawal');

    messageText += `💰 Deposits: ${depositStats.count} (${depositStats.total.toFixed(2)} ETB)\n`;
    messageText += `💸 Withdrawals: ${withdrawalStats.count} (${withdrawalStats.total.toFixed(2)} ETB)\n`;
    messageText += `🔄 Last Activity: ${moment(transactions[0]?.created_at).fromNow()}\n\n`;
    messageText += `Recent Games:\n${getRecentGames(transactions)}`;

    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      callback_query_id: callbackQuery.id
    });

    await sendTelegramMessage(chatId, messageText);
  } catch (error) {
    console.error('Player stats error:', error);
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      callback_query_id: callbackQuery.id,
      text: 'Error fetching player stats',
      show_alert: true
    });
  }
}

// Helper functions
function calculateTransactionStats(transactions, type) {
  const filtered = transactions.filter(tx => tx.transaction_type === type && tx.status === 'approved');
  return {
    count: filtered.length,
    total: filtered.reduce((sum, tx) => sum + tx.amount, 0)
  };
}

function getRecentGames(transactions) {
  const games = new Set();
  transactions.forEach(tx => {
    if (tx.game_id) games.add(tx.game_id);
  });
  return Array.from(games).slice(0, 3).join('\n') || 'N/A';
}

// Initialize the bot
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  if (process.env.NODE_ENV === 'production') {
    startDepositMonitoring();
    setupBotCommands();
    scheduleDailyReport();
  }
});
