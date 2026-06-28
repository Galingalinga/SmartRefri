import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import rateLimit from 'express-rate-limit';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Rate limiting to prevent Denial of Service (DoS) on file reads / static assets
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // limit each IP to 200 requests per 15 minutes
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Parse JSON request body up to 10MB (necessary for base64 image data)
app.use(express.json({ limit: '10mb' }));

// Initialize Google Gen AI
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.warn("WARNING: GEMINI_API_KEY environment variable is not set.");
}
const ai = new GoogleGenAI({ apiKey });

// Helper function to get offset date
function getOffsetDateString(daysOffset) {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const date = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${date}`;
}

/**
 * POST /api/recognize
 * Receives base64 image and current food inventory list,
 * runs Gemini multi-modal model to identify ingredients and merge them,
 * and returns the updated inventory list.
 */
app.post('/api/recognize', async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY' || apiKey === 'MY_GEMINI_API_KEY') {
      return res.status(400).json({ 
        error: 'API 金鑰未設定', 
        details: '偵測到您的 .env 檔案中仍是預設的預留字。請在 c:\\Users\\zeroc\\Desktop\\SideProject\\SmartRefri\\.env 中填入真實的 GEMINI_API_KEY，並重新啟動後端伺服器！' 
      });
    }

    const { image, currentInventory } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'Image is required.' });
    }

    // Extract raw base64 data and mimeType
    const matches = image.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
    let mimeType = 'image/jpeg';
    let base64Data = image;

    if (matches && matches.length === 3) {
      mimeType = matches[1];
      base64Data = matches[2];
    } else {
      // If it is raw base64 without prefix
      if (image.startsWith('data:')) {
        return res.status(400).json({ error: 'Invalid image data URI format.' });
      }
    }

    const todayStr = getOffsetDateString(0);
    const defaultExpiryStr = getOffsetDateString(7);

    const promptText = `
You are a Smart Refrigerator AI Agent.
Analyze the provided photo of new ingredients being placed into the refrigerator and identify all food items.
Return a JSON array of ONLY the detected ingredients in the photo.

Today's date is: ${todayStr}

Guidelines:
1. Identify the name, storage category ("冷藏室" or "冷凍庫"), quantity, and expiration date of each ingredient visible in the photo.
2. Classification rules:
   - "冷藏室": For milk, yogurt, eggs, vegetables, fruits, cheese, bread, desserts, drinks, etc.
   - "冷凍庫": For raw meat, seafood, frozen food, ice cream, etc.
3. Expiration Date Rules:
   - For fresh milk ("鮮乳") or packaged meat ("包裝肉品") or products with printed dates: if a date is clearly visible on the item in the image, use that date.
   - For loose fruits/vegetables ("散裝蔬果"), or if the date on the item is hidden/unclear/not visible: default the expiration date to exactly 7 days from today (i.e., today's date + 7 days, which is: ${defaultExpiryStr}).
`;

    // Attempt model calls with fallback
    let response;
    let successModel = '';
    const models = ['gemini-3.1-flash-lite', 'gemini-2.5-flash'];
    let lastError = null;

    for (const modelName of models) {
      try {
        console.log(`Calling Gemini API using model: ${modelName}`);
        response = await ai.models.generateContent({
          model: modelName,
          contents: [
            promptText,
            {
              inlineData: {
                data: base64Data,
                mimeType: mimeType
              }
            }
          ],
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'ARRAY',
              description: 'The updated complete list of all food items in the refrigerator.',
              items: {
                type: 'OBJECT',
                properties: {
                  name: { type: 'STRING', description: 'Name of the ingredient' },
                  category: { type: 'STRING', enum: ['冷藏室', '冷凍庫'], description: 'Storage location' },
                  qty: { type: 'INTEGER', description: 'Quantity of the item' },
                  expiry: { type: 'STRING', description: 'Expiration date in YYYY-MM-DD format' }
                },
                required: ['name', 'category', 'qty', 'expiry']
              }
            }
          }
        });
        successModel = modelName;
        break; // Successfully got response
      } catch (err) {
        console.warn(`Model ${modelName} failed:`, err.message);
        lastError = err;
      }
    }

    if (!response) {
      throw lastError || new Error('All Gemini model calls failed');
    }

    const resultText = response.text;
    console.log(`Success with model ${successModel}. Response:`, resultText);
    
    // Parse response content and return
    const updatedInventory = JSON.parse(resultText);
    res.json({ success: true, model: successModel, foods: updatedInventory });

  } catch (error) {
    console.error('Recognition error:', error);
    res.status(500).json({ error: 'Failed to process image recognition', details: error.message });
  }
});

// Serve static files from Vite build output directory 'dist'
app.use(express.static(path.join(__dirname, 'dist')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
