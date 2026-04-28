# 🎤 Candidate Interview View – Text Questions + Voice Answers

## What Candidate Sees

### Layout (Top to Bottom):
1. **Recording Button Section** (Prominent at top)
   - 🎤 Start Recording button
   - 📞 End Call button
   - Microphone indicator (green pulse when recording)

2. **Interviewer Header**
   - Avatar + Name + Title (AI Interviewer)
   - Live status indicator (green dot)

3. **Question Box** (Blue-highlighted)
   ```
   📝 Your Question:
   "Tell me about your experience with React..."
   ```
   - Displays the agent's current question in large, readable text
   - Updates in real-time as agent asks new questions

4. **Live Transcription Box** (Green, visible when recording)
   ```
   🎤 Your Speech (Live):
   "I have 5 years of React experience..."
   ```
   - Shows speech-to-text in real-time as candidate speaks
   - Waveform animation while recording

5. **Status Badge**
   - "Recording & Listening..." or "Ready"
   - Indicates current state

---

## How the Flow Works

```
┌─────────────────────────────────────────────────────┐
│ CANDIDATE CLICKS: 🎤 Start Recording               │
└──────────────────────┬────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│ Browser microphone captures voice                   │
│ Speech Stack (port 8012) converts to text          │
└──────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│ Candidate sees live transcription in green box     │
│ "I have 5 years of React experience..."           │
└──────────────────────────────────────────────────────┘
                       │
                  (2 seconds of silence)
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│ AUTO-SEND: Text + sentiment sent to Python agent  │
│ → Python agent (@:8013) processes answer           │
│ → Computes score, difficulty, stress level         │
│ → Generates NEXT question                          │
└──────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│ Next question appears in blue box:                  │
│ "What's your experience with state management?"   │
│ RH sees stress meter, candidate sees clean Q       │
└──────────────────────────────────────────────────────┘
                       │
                       ▼
          (Candidate speaks again...)
                       │
                       ▼
          ✅ Loop repeats until END CALL
```

---

## Key Features

✅ **Text-Based Questions**
- Each question appears clearly in a dedicated blue box
- No confusion with chat clutter
- Updates automatically when agent asks

✅ **Live Transcription Feedback**
- Green box shows your words as you speak
- Real-time feedback = confidence that STT is working
- Waveform animation shows you're being heard

✅ **No Manual Submission**
- Auto-sends after 2 seconds of silence
- No need to press "Send" button
- Natural conversation flow

✅ **Clean, Focused UI**
- Interview interviewer info at top
- Single question visible at a time
- No scoring/metrics distraction (those go to RH only)

✅ **Mobile-Friendly**
- Responsive layout adapts to screen size
- Touch-friendly buttons
- Easy to read on small screens

---

## Backend Events

**Socket Events in Use:**

1. **`agent:message`** (from Node → Candidate)
   ```json
   {
     "text": "Tell me about your React experience",
     "skillFocus": "React",
     "difficulty": 3,
     "phase": "technical"
   }
   ```

2. **`transcription-update`** (from Node → Candidate)
   ```json
   {
     "segment": { "text": "I have 5 years..." },
     "sentiment": { "label": "POSITIVE", "score": 0.9 }
   }
   ```

3. **`agent:candidate-turn`** (Auto-sent by Candidate)
   ```json
   {
     "text": "I have 5 years of React experience",
     "sentiment": { "label": "POSITIVE", "score": 0.9 },
     "roomId": "room_abc123",
     "roomDbId": "db_id_xyz"
   }
   ```

---

## What RH Sees (For Reference)

- Same agent panel with questions + scores
- **Stress meter** (visual bar indicating candidate's stress level)
- Agent mode indicator (NORMAL → WARM → SUPPORTIVE → RESET)
- Live transcription feed
- Overall sentiment tracking
- Full transcript at end

---

## Testing Checklist

- [ ] Click "Start Recording" → microphone activates (pulse visible)
- [ ] Speak clearly → words appear in **green Live Transcription box**
- [ ] After 2 seconds silence → green box stops updating
- [ ] Next question appears in **blue Question box**
- [ ] RH sees same question + stress meter + sentiment in dashboard
- [ ] Candidate doesn't see scoring/stress (clean focus)
- [ ] Can switch to Technical phase
- [ ] Interview can end cleanly

---

## Future Enhancements

- [ ] Confidence score per answer (visual indicator)
- [ ] "Retry" button if STT misheard
- [ ] Keyboard alternative to voice (type answer)
- [ ] Accent/language detection feedback
- [ ] Practice mode with practice questions

