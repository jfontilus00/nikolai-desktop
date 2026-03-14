import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import type { ChatThread, Message } from '../types';

interface UseChatsResult {
  chats: ChatThread[];
  setChats: React.Dispatch<React.SetStateAction<ChatThread[]>>;
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  loading: boolean;
  error: string | null;
  createChat: (title?: string) => Promise<string>;
  saveMessage: (convId: string, role: string, content: string) => Promise<Message | null>;
  deleteChat: (id: string) => Promise<void>;
}

export function useChats(): UseChatsResult {
  const [chats, setChats] = useState<ChatThread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load conversations from SQLite on mount
  useEffect(() => {
    async function loadChatsFromDb() {
      try {
        // Get conversation list
        const conversations = await invoke<any[]>('conversation_list');
        
        // Load messages for each conversation
        const chatThreads = await Promise.all(
          conversations.map(async (conv) => {
            const messages = await invoke<any[]>('message_list', {
              conversationId: conv.id
            });
            
            return {
              id: conv.id,
              title: conv.title,
              createdAt: conv.created_at,
              updatedAt: conv.updated_at || conv.created_at,
              messages: messages.map((m) => ({
                id: m.id,
                role: m.role as Message['role'],
                content: m.content,
                ts: m.created_at,
              })),
            } as ChatThread;
          })
        );
        
        setChats(chatThreads);
        
        // Load active chat ID from localStorage (keep for now)
        const storedActiveId = localStorage.getItem('nikolai.activeChatId.v1');
        if (storedActiveId && chatThreads.some(c => c.id === storedActiveId)) {
          setActiveId(storedActiveId);
        } else if (chatThreads.length > 0) {
          setActiveId(chatThreads[0].id);
        }
      } catch (err: any) {
        console.error('Failed to load chats:', err);
        setError(err.message || 'Failed to load chats');
      } finally {
        setLoading(false);
      }
    }
    
    loadChatsFromDb();
  }, []);

  // Create new conversation in SQLite
  const createChat = useCallback(async (title?: string): Promise<string> => {
    const conv = await invoke<any>('conversation_create', { title });
    const newChat: ChatThread = {
      id: conv.id,
      title: conv.title,
      createdAt: conv.created_at,
      updatedAt: conv.created_at,
      messages: [],
    };
    
    setChats(prev => [newChat, ...prev]);
    setActiveId(conv.id);
    
    // Persist active chat ID
    localStorage.setItem('nikolai.activeChatId.v1', conv.id);
    
    return conv.id;
  }, []);

  // Save single message to SQLite (not entire chat)
  const saveMessage = useCallback(async (
    convId: string,
    role: string,
    content: string
  ): Promise<Message | null> => {
    try {
      const msg = await invoke<any>('message_send', {
        conversationId: convId,
        role,
        content,
      });
      
      const newMessage: Message = {
        id: msg.id,
        role: role as Message['role'],
        content: msg.content,
        ts: msg.created_at,
      };
      
      // Update React state with the new message
      setChats(prev => prev.map(chat => {
        if (chat.id !== convId) return chat;
        return {
          ...chat,
          updatedAt: Date.now(),
          messages: [...chat.messages, newMessage],
        };
      }));
      
      return newMessage;
    } catch (err: any) {
      console.error('Failed to save message:', err);
      return null;
    }
  }, []);

  // Delete conversation from SQLite
  const deleteChat = useCallback(async (id: string): Promise<void> => {
    await invoke('conversation_delete', { conversationId: id });
    setChats(prev => prev.filter(c => c.id !== id));
    if (activeId === id) {
      setActiveId(null);
    }
  }, [activeId]);

  return {
    chats,
    setChats,
    activeId,
    setActiveId,
    loading,
    error,
    createChat,
    saveMessage,
    deleteChat,
  };
}
