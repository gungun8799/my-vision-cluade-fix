// Test script to check if Lotus LLM API is currently working
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const LOTUS_LLM_URL = 'https://api-cpxis.lotuss.com/llm/v1/chat/completions';
const LOTUS_API_KEY = 'accounting.lotuss.F51DAF28FD6422DDF3CD864F833CC';

async function testLotusAPI() {
  console.log('🧪 Testing Lotus LLM API availability...\n');
  
  const testMessage = {
    model: 'default',
    messages: [
      {
        role: 'system',
        content: 'You are a helpful assistant. Respond with a simple JSON object.'
      },
      {
        role: 'user', 
        content: 'Test message. Please respond with: {"status": "working", "message": "API is functional"}'
      }
    ],
    temperature: 0.1,
    max_tokens: 100
  };

  console.log('📡 Sending test request to Lotus LLM...');
  console.log('URL:', LOTUS_LLM_URL);
  console.log('Request body:', JSON.stringify(testMessage, null, 2));
  
  try {
    const startTime = Date.now();
    
    const response = await axios.post(LOTUS_LLM_URL, testMessage, {
      headers: {
        'Authorization': `Bearer ${LOTUS_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000 // 30 second timeout
    });
    
    const endTime = Date.now();
    const responseTime = endTime - startTime;
    
    console.log('✅ SUCCESS: Lotus LLM API is working!');
    console.log('⏱️  Response time:', responseTime + 'ms');
    console.log('📊 Status code:', response.status);
    console.log('📨 Response data:', JSON.stringify(response.data, null, 2));
    
    // Check if response contains expected content
    const content = response.data?.choices?.[0]?.message?.content;
    if (content) {
      console.log('💬 Message content:', content);
      try {
        const parsed = JSON.parse(content);
        if (parsed.status === 'working') {
          console.log('🎉 API responded correctly with expected JSON format!');
        } else {
          console.log('⚠️  API responded but not with expected content');
        }
      } catch (e) {
        console.log('⚠️  API responded but content is not valid JSON');
      }
    }
    
  } catch (error) {
    console.log('❌ FAILED: Lotus LLM API is not working');
    console.log('Error type:', error.constructor.name);
    console.log('Error message:', error.message);
    
    if (error.response) {
      console.log('📊 HTTP Status:', error.response.status);
      console.log('📊 Status text:', error.response.statusText);
      console.log('📨 Response data:', error.response.data);
      
      // Specific error analysis
      switch (error.response.status) {
        case 503:
          console.log('💡 Analysis: Service Unavailable (503) - Server is temporarily overloaded or down');
          break;
        case 502:
          console.log('💡 Analysis: Bad Gateway (502) - Server received invalid response from upstream');
          break;
        case 504:
          console.log('💡 Analysis: Gateway Timeout (504) - Server took too long to respond');
          break;
        case 401:
          console.log('💡 Analysis: Unauthorized (401) - API key may be invalid');
          break;
        case 429:
          console.log('💡 Analysis: Too Many Requests (429) - Rate limit exceeded');
          break;
        default:
          console.log('💡 Analysis: HTTP error', error.response.status);
      }
    } else if (error.request) {
      console.log('💡 Analysis: Network error - could not reach the server');
      console.log('Request details:', error.request);
    } else {
      console.log('💡 Analysis: Request configuration error');
    }
  }
  
  console.log('\n🏁 Test completed');
}

// Run the test
testLotusAPI().catch(console.error);