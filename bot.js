const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(express.json());

// Environment variables
const BOT_TOKEN = process.env.BOT_TOKEN || '7971577643:AAFcL38ZrahWxEyyIcz3dO4aC9yq9LTAD5M';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://evberyanshxxalxtwnnc.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'your-supabase-key';
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Initialize Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Rate limiting for API calls
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later'
});
app.use(limiter);

// Realtime subscription setup
let subscription;
let notificationQueue = [];
let isProcessingQueue = false;
let botCommands = [];

// Bot commands configuration
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
      description: 'Get system statistics (admin only)',
      handler: handleStatsCommand,
      adminOnly: true
    },
    {
      command: 'pending',
      description: 'Get pending deposits count (admin only)',
      handler: handlePendingCommand,
      adminOnly: true
    },
    {
      command: 'balance',
      description: 'Check your current balance',
      handler: handleBalanceCommand
    }
  ];

  // Register commands with Telegram
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands`, {
      commands: botCommands.map(cmd => ({
        command: cmd.command,
        description: cmd.description
      }))
    });
    console.log('Bot commands registered successfully');
  } catch (error) {
    console.error('Failed to register bot commands:', error.message);
  }
};

// Command handlers
async function handleStartCommand(chatId) {
  await sendTelegramMessage(chatId, `👋 Welcome to the Deposit Approval Bot!\n\nUse /help to see available commands.`);
}

async function handleHelpCommand(chatId) {
  const availableCommands = botCommands
    .filter(cmd => !cmd.adminOnly || chatId.toString() === ADMIN_CHAT_ID)
    .map(cmd => `/${cmd.command} - ${cmd.description}`)
    .join('\n');
  
  await sendTelegramMessage(chatId, `📚 Available Commands:\n\n${availableCommands}`);
}

async function handleStatsCommand(chatId) {
  try {
    // Get total deposits count
    const { count: totalDeposits } = await supabase
      .from('player_transactions')
      .select('*', { count: 'exact', head: true })
      .eq('transaction_type', 'deposit');

    // Get pending deposits count
    const { count: pendingDeposits } = await supabase
      .from('player_transactions')
      .select('*', { count: 'exact', head: true })
      .eq('transaction_type', 'deposit')
      .eq('status', 'pending');

    // Get total users count
    const { count: totalUsers } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true });

    const statsMessage = `📊 System Statistics:\n\n` +
      `👥 Total Users: ${totalUsers}\n` +
      `💰 Total Deposits: ${totalDeposits}\n` +
      `⏳ Pending Deposits: ${pendingDeposits}\n` +
      `📝 Queue Length: ${notificationQueue.length}\n` +
      `🔄 Subscription Status: ${subscription ? 'Active' : 'Inactive'}`;

    await sendTelegramMessage(chatId, statsMessage);
  } catch (error) {
    console.error('Error fetching stats:', error);
    await sendTelegramMessage(chatId, '❌ Error fetching statistics. Please try again later.');
  }
}

async function handlePendingCommand(chatId) {
  try {
    const { count: pendingDeposits } = await supabase
      .from('player_transactions')
      .select('*', { count: 'exact', head: true })
      .eq('transaction_type', 'deposit')
      .eq('status', 'pending');

    await sendTelegramMessage(chatId, `⏳ There are currently ${pendingDeposits} pending deposits.`);
  } catch (error) {
    console.error('Error fetching pending deposits:', error);
    await sendTelegramMessage(chatId, '❌ Error fetching pending deposits count.');
  }
}

async function handleBalanceCommand(chatId) {
  try {
    // Get user phone number from chat ID (you'll need to implement this mapping)
    const { data: user, error } = await supabase
      .from('users')
      .select('phone, balance')
      .eq('telegram_chat_id', chatId)
      .single();

    if (error || !user) {
      return await sendTelegramMessage(chatId, '❌ User not found. Please register first.');
    }

    await sendTelegramMessage(chatId, `💰 Your current balance is: ${user.balance.toFixed(2)} ETB`);
  } catch (error) {
    console.error('Error fetching balance:', error);
    await sendTelegramMessage(chatId, '❌ Error fetching your balance. Please try again later.');
  }
}

// Utility function to send Telegram messages
async function sendTelegramMessage(chatId, text, options = {}) {
  try {
    const response = await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        ...options
      }
    );
    return response.data;
  } catch (error) {
    console.error('Error sending Telegram message:', error.message);
    throw error;
  }
}

// Webhook setup endpoint
app.get('/set-webhook', async (req, res) => {
  try {
    const url = `${process.env.RAILWAY_PUBLIC_DOMAIN || `http://localhost:${PORT}`}/webhook`;
    const response = await axios.get(
      `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${url}`
    );
    
    // Setup bot commands
    await setupBotCommands();
    
    // Start monitoring after webhook is set
    await startDepositMonitoring();
    
    // Schedule daily stats report
    scheduleDailyReport();
    
    res.send({
      ...response.data,
      monitoring_status: 'Active',
      webhook_url: url,
      commands_registered: botCommands.length
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

// Schedule daily report to admin
function scheduleDailyReport() {
  // Run at 9 AM every day
  cron.schedule('0 9 * * *', async () => {
    try {
      await handleStatsCommand(ADMIN_CHAT_ID);
      console.log('Daily stats report sent');
    } catch (error) {
      console.error('Error sending daily report:', error);
    }
  });
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

// Enhanced deposit notification with more details
async function sendDepositNotification(deposit) {
  // Get user details
  const { data: user, error: userError } = await supabase
    .from('users')
    .select('name, telegram_chat_id')
    .eq('phone', deposit.player_phone)
    .single();

  const userName = user?.name || 'Unknown';
  const userTelegram = user?.telegram_chat_id ? `@${user.telegram_chat_id}` : 'Not linked';

  const message = `💰 *New Deposit Request* 💰\n\n` +
                 `🆔 *ID:* ${deposit.id}\n` +
                 `👤 *User:* ${userName}\n` +
                 `📱 *Phone:* ${deposit.player_phone}\n` +
                 `💬 *Telegram:* ${userTelegram}\n` +
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
            { text: "❌ Reject", callback_data: `reject_${deposit.id}` },
            { text: "ℹ️ Details", callback_data: `details_${deposit.id}` }
          ]
        ]
      }
    }
  );

  console.log(`Notification sent for deposit ${deposit.id}`);
  return response.data;
}

// Webhook handler with enhanced functionality
app.post('/webhook', async (req, res) => {
  try {
    const update = req.body;
    
    // Handle callback queries (button presses)
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    }
    
    // Handle regular messages
    if (update.message && update.message.text) {
      await handleMessage(update.message);
    }
    
    res.send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Error processing request');
  }
});

// Handle callback queries
async function handleCallbackQuery(callbackQuery) {
  const [action, txId] = callbackQuery.data.split('_');
  const chatId = callbackQuery.message.chat.id;
  
  if (action === 'details') {
    return handleTransactionDetails(chatId, txId, callbackQuery);
  }

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

  // Notify user about the transaction status
  if (transaction.player_phone) {
    try {
      const { data: user } = await supabase
        .from('users')
        .select('telegram_chat_id')
        .eq('phone', transaction.player_phone)
        .single();

      if (user?.telegram_chat_id) {
        const statusMessage = status === 'approved' 
          ? `✅ Your deposit of ${transaction.amount.toFixed(2)} ETB has been approved!` 
          : `❌ Your deposit of ${transaction.amount.toFixed(2)} ETB was rejected.`;

        await sendTelegramMessage(user.telegram_chat_id, statusMessage);
      }
    } catch (userError) {
      console.error('Error notifying user:', userError);
    }
  }

  // Telegram API responses
  await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    callback_query_id: callbackQuery.id,
    text: `Transaction ${status}!`,
    show_alert: true
  });

  await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
    chat_id: callbackQuery.message.chat.id,
    message_id: callbackQuery.message.message_id,
    text: `${callbackQuery.message.text}\n\nStatus: ${status.toUpperCase()}`,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [] } // Remove buttons
  });

  console.log(`Transaction ${txId} ${status}`);
}

// Handle transaction details request
async function handleTransactionDetails(chatId, txId, callbackQuery) {
  try {
    const { data: transaction, error } = await supabase
      .from('player_transactions')
      .select('*')
      .eq('id', txId)
      .single();

    if (error) throw error;

    // Get user details
    const { data: user } = await supabase
      .from('users')
      .select('name, balance')
      .eq('phone', transaction.player_phone)
      .single();

    const detailsMessage = `📄 *Transaction Details*\n\n` +
      `🆔 ID: ${transaction.id}\n` +
      `👤 User: ${user?.name || 'Unknown'}\n` +
      `📱 Phone: ${transaction.player_phone}\n` +
      `💰 Amount: ${transaction.amount.toFixed(2)} ETB\n` +
      `📅 Created: ${new Date(transaction.created_at).toLocaleString()}\n` +
      `🔄 Status: ${transaction.status}\n` +
      `📝 Description: ${transaction.description || 'None'}\n\n` +
      `💳 Current Balance: ${user?.balance.toFixed(2) || '0.00'} ETB`;

    // Answer the callback query
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      callback_query_id: callbackQuery.id
    });

    // Send details in a new message
    await sendTelegramMessage(chatId, detailsMessage);
  } catch (error) {
    console.error('Error fetching transaction details:', error);
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      callback_query_id: callbackQuery.id,
      text: 'Error fetching transaction details',
      show_alert: true
    });
  }
}

// Handle incoming messages
async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = message.text;
  
  // Check if message is a command
  if (text.startsWith('/')) {
    const command = text.split(' ')[0].substring(1).toLowerCase();
    const cmdConfig = botCommands.find(cmd => cmd.command === command);
    
    if (cmdConfig) {
      // Check admin permissions
      if (cmdConfig.adminOnly && chatId.toString() !== ADMIN_CHAT_ID) {
        return await sendTelegramMessage(chatId, '⛔ You do not have permission to use this command.');
      }
      
      // Execute command handler
      await cmdConfig.handler(chatId, message);
    } else {
      await sendTelegramMessage(chatId, '❌ Unknown command. Use /help to see available commands.');
    }
  }
}

// Enhanced user balance update with transaction history
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

    // Record balance change
    await supabase
      .from('balance_history')
      .insert({
        user_phone: transaction.player_phone,
        amount: transaction.amount,
        previous_balance: user?.balance || 0,
        new_balance: newBalance,
        transaction_id: txId,
        change_type: 'deposit'
      });

    console.log(`Updated balance for ${transaction.player_phone}`);
  } catch (error) {
    console.error('Balance update error:', error);
    throw error;
  }
}

// Health check endpoint with more details
app.get('/', (req, res) => {
  res.send(`
    <h1>Deposit Approval System</h1>
    <p>Server is running in ${NODE_ENV} mode!</p>
    <ul>
      <li><a href="/set-webhook">Setup Webhook</a></li>
      <li>Webhook URL: <code>/webhook</code></li>
      <li>Monitoring Status: ${subscription ? 'Active' : 'Inactive'}</li>
      <li>Pending Notifications: ${notificationQueue.length}</li>
      <li>Registered Commands: ${botCommands.length}</li>
      <li>Environment: ${NODE_ENV}</li>
    </ul>
    <h2>Available Commands</h2>
    <ul>
      ${botCommands.map(cmd => `<li><code>/${cmd.command}</code> - ${cmd.description}</li>`).join('')}
    </ul>
  `);
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Global error handler:', err);
  res.status(500).send('Something broke!');
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Webhook URL: ${process.env.RAILWAY_PUBLIC_DOMAIN || `http://localhost:${PORT}`}/webhook`);
  
  // Auto-start monitoring if in production
  if (process.env.NODE_ENV === 'production') {
    startDepositMonitoring();
    setupBotCommands();
    scheduleDailyReport();
  }
});
