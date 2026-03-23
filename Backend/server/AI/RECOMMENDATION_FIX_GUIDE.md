# 🤖 AI Job Recommendation System - Quick Fix Guide

## 🔍 **Why Your React Job Isn't Showing in Recommendations**

The AI recommendation system uses **semantic matching** between candidate profiles and job postings. Here's why your React frontend developer job might not appear:

### **Main Reasons:**

1. **❌ AI Service Not Running**
   - The Python AI service must be running on port 5001
   - Without it, recommendations won't work

2. **⏰ Job Index Not Updated**
   - Job index is cached for 1 hour
   - New jobs won't appear until cache expires or manual refresh

3. **📊 Low Match Score**
   - Candidate profile doesn't have React/frontend skills
   - Match score below threshold (now 20%)

4. **🔄 Already Applied**
   - System filters out jobs the candidate already applied to

---

## ✅ **Quick Fix Steps**

### **Step 1: Start the AI Service**

```bash
cd Backend/server/AI

# Install dependencies (first time only)
pip install -r requirements.txt

# Start the AI service
python recommendation_service.py
```

You should see: `Running on http://0.0.0.0:5001`

---

### **Step 2: Run the Diagnostic Script**

```bash
cd Backend/server/AI
python test_recommendations.py
```

This will:
- ✅ Check if AI service is running
- ✅ Refresh the job index
- ✅ Show you all jobs and candidates
- ✅ Test recommendations with actual data

---

### **Step 3: Update Candidate Profile**

For the React job to match, the candidate needs relevant skills:

**Example skills to add:**
- React
- JavaScript
- Frontend Development
- HTML/CSS
- TypeScript
- Redux
- Node.js

**How to add:**
1. Log in as candidate
2. Go to Profile → Edit
3. Add skills in the "Skills" section
4. Save profile

---

### **Step 4: Force Refresh (Optional)**

If you just added a new job, force refresh the index:

```bash
# Using curl
curl -X POST http://127.0.0.1:5001/refresh-index

# Or using the test script
python test_recommendations.py
```

---

## 📊 **How the AI System Works**

### **1. Job Embedding Creation**
```
Job: "React Frontend Developer"
Skills: [React, JavaScript, HTML, CSS]
Location: "Remote"
↓
AI creates vector: [0.23, 0.45, 0.12, ...]
```

### **2. Candidate Embedding**
```
Candidate Profile:
Skills: [React, JavaScript, TypeScript]
Experience: "2 years as Frontend Developer"
↓
AI creates vector: [0.21, 0.48, 0.15, ...]
```

### **3. Similarity Calculation**
```
Cosine Similarity (Job Vector, Candidate Vector) = 0.87
↓
Match Score: 87%
```

### **4. Filtering & Ranking**
- ❌ Filter out scores < 20%
- ❌ Filter out already applied jobs
- ✅ Return top 10 matches sorted by score

---

## 🎯 **Match Score Thresholds**

| Score | Meaning |
|-------|---------|
| **80-100%** | Excellent match - Candidate has all required skills |
| **60-79%** | Good match - Most skills align |
| **40-59%** | Moderate match - Some relevant experience |
| **20-39%** | Fair match - General field match |
| **< 20%** | Low match - Filtered out |

**Current threshold: 20%** (lowered from 30% to show more jobs)

---

## 🔧 **Troubleshooting**

### **Problem: No recommendations showing**

**Check:**
1. Is AI service running? `python recommendation_service.py`
2. Are there jobs in database? Run `test_recommendations.py`
3. Does candidate have skills? Check profile
4. Check backend console for errors

### **Problem: Wrong jobs showing**

**Solution:**
- Add more specific skills to candidate profile
- Update job descriptions with clear requirements
- Skills weight heavily in matching algorithm

### **Problem: Service connection refused**

**Solution:**
```bash
# Make sure AI service is running
cd Backend/server/AI
python recommendation_service.py

# In another terminal, check Node.js backend is running
cd Backend/server
npm start
```

---

## 📝 **Configuration Changes Made**

1. ✅ **Lowered threshold**: 30% → 20% for more matches
2. ✅ **Increased results**: 5 → 10 recommendations
3. ✅ **Added refresh endpoint**: Force update job index
4. ✅ **Added health check**: Monitor service status
5. ✅ **Better debugging**: More console logs

---

## 🚀 **Testing Your Setup**

### **Quick Test:**

1. **Start AI service:**
   ```bash
   cd Backend/server/AI
   python recommendation_service.py
   ```

2. **Run diagnostic:**
   ```bash
   python test_recommendations.py
   ```

3. **Check output:**
   - Should see your React job listed
   - Should see match scores
   - Should see candidate profiles

4. **Refresh frontend:**
   - Log in as candidate
   - Go to Home page
   - Check "Recommended For You" section

---

## 💡 **Tips for Better Recommendations**

### **For Job Postings:**
✅ Add detailed skills list (React, JavaScript, TypeScript, etc.)
✅ Write clear job description with technologies
✅ Include experience level requirements
✅ Add specific frameworks/libraries

### **For Candidate Profiles:**
✅ Add all relevant skills
✅ Include years of experience
✅ Write detailed resume summary
✅ List programming languages
✅ Update regularly

---

## 📞 **Still Not Working?**

Check the backend console logs:

```bash
# Node.js backend
cd Backend/server
npm start

# Look for these messages:
# ✅ "Recommendation service connected"
# ❌ "Recommendation service unavailable"
```

Check Python AI service logs:

```bash
# Python AI service
cd Backend/server/AI
python recommendation_service.py

# Look for debug output:
# [DEBUG] Found X jobs in database
# [DEBUG] Generating embeddings...
# [SUCCESS] Indexed X jobs
```

---

## 🎉 **Success Indicators**

You'll know it's working when:
- ✅ Diagnostic script shows jobs indexed
- ✅ Recommendations appear on candidate home page
- ✅ Match scores shown (e.g., "87% Match")
- ✅ New jobs appear after refresh
- ✅ Relevant jobs show high scores

---

**Need help? Check the console logs for detailed debugging information!**
