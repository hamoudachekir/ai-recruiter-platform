const express = require('express');
const router = express.Router();
const Message = require('../models/Message');
const mongoose = require('mongoose');
const User = require('../models/user');
const { v4: uuidv4 } = require('uuid');
const OpenAI = require('openai').default || require('openai');

// Groq client (OpenAI-compatible)
const groqClient = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

async function askGroq(systemPrompt, userMessage) {
  const resp = await groqClient.chat.completions.create({
    model: GROQ_MODEL,
    max_tokens: 200,
    temperature: 0.6,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userMessage },
    ],
  });
  return resp.choices[0]?.message?.content?.trim() || '';
}

// Save message
router.post('/send', async (req, res) => {
  const { from, to, text } = req.body;

  try {
    const messageId = uuidv4();
    const newMessage = new Message({
      messageId,
      from,
      to,
      text,
      timestamp: new Date()
    });

    await newMessage.save();
    console.log(`✅ Message saved: ${messageId}`);
    res.status(200).json({ success: true, msg: "Message saved", messageId });
  } catch (err) {
    console.error("❌ Error saving message:", err.message);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

// Get message history between two users
router.get('/history/:user1/:user2', async (req, res) => {
  const { user1, user2 } = req.params;

  const allowedSpecialUsers = ['system', 'bot'];

  const isUser1Special = allowedSpecialUsers.includes(user1);
  const isUser2Special = allowedSpecialUsers.includes(user2);

  const isUser1Valid = mongoose.Types.ObjectId.isValid(user1);
  const isUser2Valid = mongoose.Types.ObjectId.isValid(user2);

  try {
    let query;

    if ((isUser1Special && isUser2Valid) || (isUser2Special && isUser1Valid)) {
      const special = isUser1Special ? user1 : user2;
      const regular = isUser1Special ? user2 : user1;

      query = {
        $or: [
          { from: special, to: regular },
          { from: regular, to: special }
        ]
      };
    } else if (isUser1Valid && isUser2Valid) {
      query = {
        $or: [
          { from: user1, to: user2 },
          { from: user2, to: user1 }
        ]
      };
    } else {
      return res.status(400).json({ success: false, msg: "Invalid user ID(s)" });
    }

    const messages = await Message.find(query).sort({ timestamp: 1 });
    console.log(`✅ Fetched history for ${user1} and ${user2}`);
    res.status(200).json({ messages });
  } catch (err) {
    console.error("❌ Error fetching messages:", err.message);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

// Get all messages involving a single user
router.get('/user/:userId', async (req, res) => {
  const { userId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    return res.status(400).json({ success: false, msg: "Invalid user ID" });
  }

  try {
    const messages = await Message.find({
      $or: [
        { from: userId },
        { to: userId }
      ]
    }).sort({ timestamp: 1 });

    console.log(`✅ Fetched messages for user ${userId}`);
    res.status(200).json({ success: true, messages });
  } catch (err) {
    console.error("❌ Error fetching user's messages:", err.message);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

// Bot interaction powered by Groq
router.post('/bot/interaction', async (req, res) => {
  const { userId, message } = req.body;

  if (!userId || !message) {
    return res.status(400).json({ success: false, msg: "User ID and message are required" });
  }

  try {
    // Fetch user context
    let skillsLine = '';
    try {
      const user = await User.findById(userId).select('profile role firstName lastName name');
      if (user) {
        const skills = user.profile?.skills?.join(', ') || 'not specified';
        const exp = user.profile?.experience?.map(e => e.title).join(', ') || 'none';
        skillsLine = `Candidate skills: ${skills}. Experience: ${exp}.`;
      }
    } catch (_) {}

    // Fetch last 6 messages for context
    const recent = await Message.find({
      $or: [{ from: userId, to: 'bot' }, { from: 'bot', to: userId }],
    }).sort({ timestamp: -1 }).limit(6);
    const history = recent.reverse()
      .map(m => `${m.from === 'bot' ? 'NextBot' : 'Candidate'}: ${m.text}`)
      .join('\n');

    const systemPrompt = `You are NextBot, the AI career assistant for NextHire — an AI-powered recruitment platform. You help candidates with job applications, interview preparation, CV tips, and platform navigation.
${skillsLine}
Be concise (under 120 words), warm, and professional. Use bullet points when listing steps.
Recent conversation:\n${history || '(no prior messages)'}`;

    const reply = await askGroq(systemPrompt, message);

    // Save bot response to database
    const botMessageId = uuidv4();
    const botMessage = new Message({
      messageId: botMessageId,
      from: 'bot',
      to: userId,
      text: reply,
      timestamp: new Date()
    });
    await botMessage.save();
    console.log(`✅ Bot message saved: ${botMessageId}`);

    // Emit bot response via socket
    const io = req.app.get('socketio');
    const userSockets = require('../utils/socketMap');
    const recipientSocket = userSockets.get(userId);
    if (recipientSocket && io) {
      io.to(recipientSocket).emit('receive-message', {
        messageId: botMessageId,
        from: 'bot',
        to: userId,
        text: reply,
        timestamp: botMessage.timestamp
      });
      console.log(`✅ Emitted bot message: ${botMessageId}`);
    }

    res.status(200).json({ success: true, reply, messageId: botMessageId });
  } catch (err) {
    console.error("Bot interaction error:", err.message);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

// Send a bot message to a specific user
router.post('/bot-message', async (req, res) => {
  const { to, text, messageId } = req.body;

  try {
    // Check if message already exists
    if (messageId) {
      const existingMessage = await Message.findOne({ messageId });
      if (existingMessage) {
        console.log(`✅ Message ${messageId} already exists, skipping save`);
        return res.status(200).json({ success: true, msg: "Message already processed" });
      }
    }

    const newMessageId = messageId || uuidv4();
    const newMessage = new Message({
      messageId: newMessageId,
      from: 'bot',
      to,
      text,
      timestamp: new Date()
    });

    await newMessage.save();
    console.log(`✅ Bot message saved: ${newMessageId}`);

    // Emit via socket if user is online
    const io = req.app.get('socketio');
    const userSockets = require('../utils/socketMap');
    const recipientSocket = userSockets.get(to);

    if (recipientSocket && io) {
      io.to(recipientSocket).emit('receive-message', {
        messageId: newMessageId,
        from: 'bot',
        to,
        text,
        timestamp: newMessage.timestamp
      });
      console.log(`✅ Emitted bot message: ${newMessageId}`);
    }

    res.status(200).json({ success: true, msg: "Bot message sent", messageId: newMessageId });
  } catch (err) {
    console.error("❌ Bot message error:", err.message);
    res.status(500).json({ success: false, msg: "Server error" });
  }
});

module.exports = router;