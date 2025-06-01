import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { 
  ZulipConfig, 
  ZulipMessage, 
  ZulipStream, 
  ZulipUser, 
  ZulipUserGroup, 
  ZulipTopic,
  ZulipScheduledMessage,
  ZulipDraft
} from '../types.js';

export class ZulipClient {
  private client: AxiosInstance;
  private config: ZulipConfig;

  constructor(config: ZulipConfig) {
    this.config = config;
    this.client = axios.create({
      baseURL: `${config.url}/api/v1`,
      auth: {
        username: config.email,
        password: config.apiKey
      },
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'ZulipMCPServer/1.0.0'
      },
      timeout: 30000
    });

    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response) {
          const { status, data } = error.response;
          throw new Error(`Zulip API Error (${status}): ${data.msg || data.message || 'Unknown error'}`);
        } else if (error.request) {
          throw new Error(`Network Error: Unable to reach Zulip server at ${config.url}`);
        } else {
          throw new Error(`Request Error: ${error.message}`);
        }
      }
    );
  }

  // Message Operations
  async sendMessage(params: {
    type: 'stream' | 'direct';
    to: string;
    content: string;
    topic?: string;
  }): Promise<{ id: number }> {
    console.log('🔍 Debug - sendMessage called with:', JSON.stringify(params, null, 2));
    
    // Use the type directly - newer API supports "direct" 
    const payload: any = {
      type: params.type,
      content: params.content
    };

    // Handle recipients based on message type
    if (params.type === 'direct') {
      // For direct messages, handle both single and multiple recipients
      const recipients = params.to.includes(',') 
        ? params.to.split(',').map(email => email.trim())
        : [params.to.trim()];
      
      // Try both formats to see which works
      payload.to = recipients;  // Array format first
      console.log('🔍 Debug - Direct message recipients:', recipients);
    } else {
      // For stream messages, 'to' is the stream name
      payload.to = params.to;
      if (params.topic) {
        payload.topic = params.topic;
      }
    }

    console.log('🔍 Debug - Final payload:', JSON.stringify(payload, null, 2));

    try {
      // Try JSON first (modern API)
      const response = await this.client.post('/messages', payload);
      console.log('✅ Debug - Message sent successfully:', response.data);
      return response.data;
    } catch (jsonError) {
      console.log('⚠️ Debug - JSON request failed, trying form-encoded...');
      if (jsonError instanceof Error) {
        console.log('Error:', (jsonError as any).response?.data || jsonError.message);
      }
      
      // Fallback to form-encoded with different recipient format
      const formPayload = { ...payload };
      if (params.type === 'direct') {
        // Try JSON string format for recipients
        const recipients = params.to.includes(',') 
          ? params.to.split(',').map(email => email.trim())
          : [params.to.trim()];
        formPayload.to = JSON.stringify(recipients);
      }
      
      console.log('🔍 Debug - Form payload:', JSON.stringify(formPayload, null, 2));
      
      const response = await this.client.post('/messages', formPayload, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        transformRequest: [(data) => {
          const params = new URLSearchParams();
          for (const key in data) {
            if (data[key] !== undefined) {
              params.append(key, String(data[key]));
            }
          }
          const formString = params.toString();
          console.log('🔍 Debug - Form-encoded string:', formString);
          return formString;
        }]
      });
      
      console.log('✅ Debug - Form-encoded message sent successfully:', response.data);
      return response.data;
    }
  }

  async getMessages(params: {
    anchor?: number | string;
    num_before?: number;
    num_after?: number;
    narrow?: string[][];
    message_id?: number;
  } = {}): Promise<{ messages: ZulipMessage[] }> {
    if (params.message_id) {
      const response = await this.client.get(`/messages/${params.message_id}`);
      return { messages: [response.data.message] };
    }

    const queryParams: any = {
      anchor: params.anchor || 'newest',
      num_before: params.num_before || 20,
      num_after: params.num_after || 0
    };

    if (params.narrow) {
      queryParams.narrow = JSON.stringify(params.narrow);
    }

    const response = await this.client.get('/messages', { params: queryParams });
    return response.data;
  }

  async updateMessage(messageId: number, params: {
    content?: string;
    topic?: string;
  }): Promise<void> {
    await this.client.patch(`/messages/${messageId}`, params);
  }

  async deleteMessage(messageId: number): Promise<void> {
    await this.client.delete(`/messages/${messageId}`);
  }

  async addReaction(messageId: number, params: {
    emoji_name: string;
    emoji_code?: string;
    reaction_type?: string;
  }): Promise<void> {
    await this.client.post(`/messages/${messageId}/reactions`, {
      emoji_name: params.emoji_name,
      emoji_code: params.emoji_code,
      reaction_type: params.reaction_type || 'unicode_emoji'
    });
  }

  async getMessageReadReceipts(messageId: number): Promise<{ user_ids: number[] }> {
    const response = await this.client.get(`/messages/${messageId}/read_receipts`);
    return response.data;
  }

  // File Operations
  async uploadFile(filename: string, content: string, contentType?: string): Promise<{ uri: string }> {
    // Convert base64 to buffer
    const buffer = Buffer.from(content, 'base64');
    
    const formData = new FormData();
    const blob = new Blob([buffer], { type: contentType });
    formData.append('file', blob, filename);

    const response = await this.client.post('/user_uploads', formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      }
    });
    return response.data;
  }

  // Scheduled Messages
  async createScheduledMessage(params: {
    type: 'stream' | 'direct';
    to: string;
    content: string;
    topic?: string;
    scheduled_delivery_timestamp: number;
  }): Promise<{ scheduled_message_id: number }> {
    // Convert our types to Zulip API types
    const zulipType = params.type === 'direct' ? 'private' : 'stream';
    
    const payload: any = {
      type: zulipType,
      content: params.content,
      scheduled_delivery_timestamp: params.scheduled_delivery_timestamp
    };

    // Handle recipients based on message type
    if (params.type === 'direct') {
      // For private messages, 'to' should be JSON array of user emails/IDs
      const recipients = params.to.split(',').map(email => email.trim());
      payload.to = JSON.stringify(recipients);
    } else {
      // For stream messages, 'to' is the stream name
      payload.to = params.to;
      if (params.topic) {
        payload.topic = params.topic;
      }
    }

    const response = await this.client.post('/scheduled_messages', payload, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      transformRequest: [(data) => {
        const params = new URLSearchParams();
        for (const key in data) {
          if (data[key] !== undefined) {
            params.append(key, String(data[key]));
          }
        }
        return params.toString();  // Return string, not URLSearchParams object
      }]
    });
    return response.data;
  }

  async editScheduledMessage(scheduledMessageId: number, params: {
    type?: 'stream' | 'direct';
    to?: string;
    content?: string;
    topic?: string;
    scheduled_delivery_timestamp?: number;
  }): Promise<void> {
    await this.client.patch(`/scheduled_messages/${scheduledMessageId}`, params);
  }

  async getScheduledMessages(): Promise<{ scheduled_messages: ZulipScheduledMessage[] }> {
    const response = await this.client.get('/scheduled_messages');
    return response.data;
  }

  // Drafts
  async getDrafts(): Promise<{ drafts: ZulipDraft[] }> {
    const response = await this.client.get('/drafts');
    return response.data;
  }

  async editDraft(draftId: number, params: {
    type: 'stream' | 'direct';
    to: number[];
    topic: string;
    content: string;
    timestamp?: number;
  }): Promise<void> {
    await this.client.patch(`/drafts/${draftId}`, params);
  }

  // Stream Operations
  async getSubscriptions(includeSubscribers?: boolean): Promise<{ subscriptions: ZulipStream[] }> {
    const params = includeSubscribers ? { include_subscribers: true } : {};
    const response = await this.client.get('/users/me/subscriptions', { params });
    return response.data;
  }

  async getStreamId(streamName: string): Promise<{ stream_id: number }> {
    const response = await this.client.get('/get_stream_id', {
      params: { stream: streamName }
    });
    return response.data;
  }

  async getStream(streamId: number, includeSubscribers?: boolean): Promise<{ stream: ZulipStream }> {
    const params = includeSubscribers ? { include_subscribers: true } : {};
    const response = await this.client.get(`/streams/${streamId}`, { params });
    return response.data;
  }

  async getStreamTopics(streamId: number): Promise<{ topics: ZulipTopic[] }> {
    const response = await this.client.get(`/users/me/${streamId}/topics`);
    return response.data;
  }

  // User Operations
  async getUsers(params: {
    client_gravatar?: boolean;
    include_custom_profile_fields?: boolean;
  } = {}): Promise<{ members: ZulipUser[] }> {
    const response = await this.client.get('/users', { params });
    return response.data;
  }

  async getUserByEmail(email: string, params: {
    client_gravatar?: boolean;
    include_custom_profile_fields?: boolean;
  } = {}): Promise<{ user: ZulipUser }> {
    const response = await this.client.get(`/users/${encodeURIComponent(email)}`, { params });
    return response.data;
  }

  async updateStatus(params: {
    status_text?: string;
    away?: boolean;
    emoji_name?: string;
    emoji_code?: string;
  }): Promise<void> {
    await this.client.post('/users/me/status', params);
  }

  async getUserGroups(): Promise<{ user_groups: ZulipUserGroup[] }> {
    const response = await this.client.get('/user_groups');
    return response.data;
  }

  // Organization Operations
  async getServerSettings(): Promise<any> {
    const response = await this.client.get('/server_settings');
    return response.data;
  }

  async getRealmInfo(): Promise<any> {
    const response = await this.client.get('/realm');
    return response.data;
  }

  async getCustomEmoji(): Promise<any> {
    const response = await this.client.get('/realm/emoji');
    return response.data;
  }
}