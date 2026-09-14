import { useState, useRef, useEffect } from 'react';
import { ArrowLeft, Send, Plus, Trash2, MessageSquare, Loader2 } from 'lucide-react';
import { useAppSelector } from '../store/hooks';
import {
  useGetConversationsQuery,
  useGetConversationQuery,
  useSendMessageMutation,
  useDeleteConversationMutation,
} from '../store/services/chatApi';

interface ChatPanelProps {
  onBack: () => void;
}

export function ChatPanel({ onBack }: ChatPanelProps) {
  const projectId = useAppSelector(state => state.ui.selectedProjectId);
  const [activeConvId, setActiveConvId] = useState<number | null>(null);
  const [input, setInput] = useState('');
  const [pendingMessages, setPendingMessages] = useState<{ role: string; content: string }[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { data: conversations = [] } = useGetConversationsQuery(projectId!, { skip: !projectId });
  const { data: activeConv } = useGetConversationQuery(activeConvId!, { skip: !activeConvId });
  const [sendMessage, { isLoading }] = useSendMessageMutation();
  const [deleteConversation] = useDeleteConversationMutation();

  const messages = activeConv?.messages || [];
  const allMessages = [...messages, ...pendingMessages];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [allMessages.length]);

  useEffect(() => {
    if (!isLoading) inputRef.current?.focus();
  }, [isLoading]);

  if (!projectId) {
    return (
      <div className="chat-panel">
        <div className="chat-empty">
          <MessageSquare size={48} strokeWidth={1} />
          <p>Select a project to start chatting</p>
          <button className="btn btn-secondary" onClick={onBack}>Back to tests</button>
        </div>
      </div>
    );
  }

  const handleSend = async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    setInput('');
    setPendingMessages(prev => [...prev, { role: 'user', content: text }]);

    try {
      const result = await sendMessage({
        project_id: projectId,
        conversation_id: activeConvId || undefined,
        message: text,
      }).unwrap();

      if (!activeConvId && result.conversation_id) {
        setActiveConvId(result.conversation_id);
      }
      setPendingMessages([]);
    } catch (err: any) {
      setPendingMessages(prev => [
        ...prev,
        { role: 'assistant', content: `Error: ${err.data?.error || err.message || 'Something went wrong'}` },
      ]);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleNewConversation = () => {
    setActiveConvId(null);
    setPendingMessages([]);
    setInput('');
  };

  const handleDeleteConv = async (id: number) => {
    await deleteConversation({ id, projectId });
    if (activeConvId === id) {
      setActiveConvId(null);
      setPendingMessages([]);
    }
  };

  return (
    <div className="chat-panel">
      <div className="chat-sidebar">
        <div className="chat-sidebar-header">
          <button className="btn btn-ghost btn-sm" onClick={onBack}>
            <ArrowLeft size={16} />
          </button>
          <span className="chat-sidebar-title">Conversations</span>
          <button className="btn btn-ghost btn-sm" onClick={handleNewConversation} title="New conversation">
            <Plus size={16} />
          </button>
        </div>
        <div className="chat-conv-list">
          {conversations.map(conv => (
            <div
              key={conv.id}
              className={`chat-conv-item ${activeConvId === conv.id ? 'active' : ''}`}
              onClick={() => { setActiveConvId(conv.id); setPendingMessages([]); }}
            >
              <span className="chat-conv-title">{conv.title || 'New conversation'}</span>
              <span className="chat-conv-count">{conv.message_count}</span>
              <button
                className="chat-conv-delete"
                onClick={(e) => { e.stopPropagation(); handleDeleteConv(conv.id); }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          {conversations.length === 0 && (
            <div className="chat-conv-empty">No conversations yet</div>
          )}
        </div>
      </div>

      <div className="chat-main">
        <div className="chat-messages">
          {allMessages.length === 0 && (
            <div className="chat-welcome">
              <MessageSquare size={40} strokeWidth={1} />
              <h3>How can I help you?</h3>
              <p>Describe a test scenario and I'll propose the Gherkin for you.</p>
              <div className="chat-suggestions">
                <button className="chat-suggestion" onClick={() => setInput('List the existing tests and suggest what\'s missing')}>
                  Suggest missing tests
                </button>
                <button className="chat-suggestion" onClick={() => setInput('I want to test the login flow')}>
                  Test the login flow
                </button>
                <button className="chat-suggestion" onClick={() => setInput('What tests should I create for this project?')}>
                  Recommend tests
                </button>
              </div>
            </div>
          )}

          {allMessages.map((msg, i) => (
            <div key={i} className={`chat-message chat-message-${msg.role}`}>
              <div className="chat-message-avatar">
                {msg.role === 'user' ? 'U' : 'AI'}
              </div>
              <div className="chat-message-content">
                <FormattedContent content={msg.content} />
              </div>
            </div>
          ))}

          {isLoading && (
            <div className="chat-message chat-message-assistant">
              <div className="chat-message-avatar">AI</div>
              <div className="chat-message-content chat-thinking">
                <Loader2 size={16} className="chat-spinner" />
                Thinking...
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        <div className="chat-input-area">
          <textarea
            ref={inputRef}
            className="chat-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe a test to create, ask a question..."
            rows={1}
            disabled={isLoading}
          />
          <button
            className="chat-send-btn"
            onClick={handleSend}
            disabled={!input.trim() || isLoading}
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Simple markdown-like rendering: code blocks, bold, inline code */
function FormattedContent({ content }: { content: string }) {
  if (!content) return null;

  const parts = content.split(/(```[\s\S]*?```)/g);

  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('```')) {
          const lines = part.slice(3, -3).split('\n');
          const lang = lines[0]?.trim();
          const code = (lang ? lines.slice(1) : lines).join('\n').trim();
          return (
            <pre key={i} className="chat-code-block" data-lang={lang || undefined}>
              <code>{code}</code>
            </pre>
          );
        }
        // Inline formatting
        const html = part
          .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
          .replace(/`(.*?)`/g, '<code class="chat-inline-code">$1</code>')
          .replace(/\n/g, '<br/>');
        return <span key={i} dangerouslySetInnerHTML={{ __html: html }} />;
      })}
    </>
  );
}
