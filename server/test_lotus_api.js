// Test script to check if Lotus LLM API is currently working
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const LOTUS_LLM_URL = 'https://api-cpxis.lotuss.com/llm/v1/chat/completions';
const LOTUS_API_KEY = 'accounting.lotuss.F51DAF28FD6422DDF3CD864F833CC';

async function testLotusAPI() {
  console.log('🧪 Testing Lotus LLM API availability with 5-second delay...\n');
  
  // Add 5-second delay to match web scraping implementation
  console.log('⏱️  Waiting 5 seconds before API call to prevent socket hang up...');
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  const testMessage = {
    model: 'default',
    messages: [
      {
        role: 'system',
        content: 'You are a contract data extraction assistant. Extract data from the provided web content and return it as a valid JSON object only.'
      },
      {
        role: 'user', 
        content: 'Test web content: Contract Number: 5114_LR2505_00107, Building Name: Test Building. Please extract this information as JSON.'
      }
    ],
    temperature: 0.1,
    max_tokens: 1000,
    extra_body: {"chat_template_kwargs": {"enable_thinking": false}}
  };

  console.log('📡 Sending test request to Lotus LLM (with thinking disabled)...');
  console.log('URL:', LOTUS_LLM_URL);
  console.log('Request body:', JSON.stringify(testMessage, null, 2));
  
  try {
    const startTime = Date.now();
    
    const response = await axios.post(LOTUS_LLM_URL, testMessage, {
      headers: {
        'Authorization': `Bearer ${LOTUS_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000 // 30 second timeout (matches web scraping implementation)
    });
    
    const endTime = Date.now();
    const responseTime = endTime - startTime;
    
    console.log('✅ SUCCESS: Lotus LLM API is working!');
    console.log('⏱️  Response time:', responseTime + 'ms');
    console.log('📊 Status code:', response.status);
    console.log('📨 Response data:', JSON.stringify(response.data, null, 2));
    
    // Check if response contains expected content
    const messageContent = response.data?.choices?.[0]?.message?.content;
    const reasoningContent = response.data?.choices?.[0]?.message?.reasoning_content;
    const content = (messageContent || reasoningContent);
    
    if (content) {
      console.log('💬 Response content:', content);
      try {
        const parsed = JSON.parse(content.trim());
        if (parsed['Contract Number'] === '5114_LR2505_00107') {
          console.log('🎉 API responded correctly with expected contract data extraction!');
        } else {
          console.log('⚠️  API responded with JSON but not expected contract data');
          console.log('📋 Extracted data:', parsed);
        }
      } catch (e) {
        console.log('⚠️  API responded but content is not valid JSON');
        console.log('🔍 Raw content for debugging:', content);
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