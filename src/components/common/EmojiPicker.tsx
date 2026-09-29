import { useId, useState } from 'react';

interface EmojiPickerProps {
  value: string;
  onChange: (emoji: string) => void;
  label?: string;
}

const EMOJI_CATEGORIES = {
  'Smileys': ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙'],
  'Activities': ['⚽', '🏀', '🏈', '⚾', '🎾', '🏐', '🏉', '🎱', '🏓', '🏸', '🥊', '🥋', '🎯', '⛳', '🎣', '🎮', '🎲', '🎭', '🎨', '🎪'],
  'Objects': ['💡', '🔦', '🏮', '📱', '💻', '⌨️', '🖥️', '🖨️', '🖱️', '🖲️', '📷', '📹', '📞', '☎️', '📟', '📠', '📺', '📻', '🎙️', '🎚️'],
  'Symbols': ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '⭐', '🌟', '✨'],
  'Work': ['💼', '📁', '📂', '🗂️', '📅', '📆', '🗒️', '🗓️', '📇', '📈', '📉', '📊', '📋', '📌', '📍', '📎', '🖇️', '📏', '📐', '✂️'],
  'Tech': ['💻', '🖥️', '⌨️', '🖱️', '🖲️', '💾', '💿', '📀', '🎮', '🕹️', '🔌', '🔋', '📱', '☎️', '📞', '📟', '📠', '🔍', '🔎', '💡'],
  'Education': ['📚', '📖', '📝', '✏️', '✒️', '🖊️', '🖋️', '🖍️', '📄', '📃', '📑', '📊', '📈', '📉', '🗒️', '🗓️', '📆', '📅', '🎓', '🏫'],
  'Creative': ['🎨', '🖌️', '🖍️', '✏️', '✒️', '🖊️', '🖋️', '📝', '✂️', '📐', '📏', '🎭', '🎪', '🎬', '🎤', '🎧', '🎼', '🎹', '🥁', '🎺'],
  'Transport': ['🚗', '🚕', '🚙', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐', '🚚', '🚛', '🚜', '🛴', '🚲', '🛵', '🏍️', '✈️', '🚀', '🛸'],
  'Nature': ['🌱', '🌿', '🍀', '🌾', '🌳', '🌲', '🌴', '🌵', '🌷', '🌸', '🌺', '🌻', '🌼', '🌹', '🥀', '🌏', '🌍', '🌎', '⭐', '✨'],
};

export function EmojiPicker({ value, onChange, label }: EmojiPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string>('Smileys');
  const triggerId = useId();

  const handleEmojiSelect = (emoji: string) => {
    onChange(emoji);
    setIsOpen(false);
  };

  return (
    <div className="relative">
      {label && (
        <label htmlFor={triggerId} className="block text-sm font-medium text-slate-700 mb-2">
          {label}
        </label>
      )}

      <button
        type="button"
        id={triggerId}
        onClick={() => setIsOpen(!isOpen)}
        aria-label={`${label ? `${label}: ` : ''}choose an emoji (currently ${value || '🚀'})`}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        className="w-32 px-4 py-2 border border-slate-200 rounded-lg hover:border-iih-green focus:ring-2 focus:ring-iih-green focus:border-transparent text-4xl text-center transition-colors"
      >
        {value || '🚀'}
      </button>

      <p className="text-xs text-slate-500 mt-1">Click to choose an emoji</p>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-label="Emoji picker"
            className="absolute z-50 mt-2 w-80 bg-white border border-slate-200 rounded-lg shadow-xl max-h-[500px] overflow-hidden flex flex-col"
          >
            <div className="p-3 border-b border-slate-200 flex-shrink-0">
              <div className="flex gap-1 overflow-x-auto pb-2 scrollbar-thin">
                {Object.keys(EMOJI_CATEGORIES).map((category) => (
                  <button
                    key={category}
                    type="button"
                    onClick={() => setSelectedCategory(category)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${
                      selectedCategory === category
                        ? 'bg-iih-green text-white'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {category}
                  </button>
                ))}
              </div>
            </div>

            <div className="p-4 grid grid-cols-8 gap-2 overflow-y-auto flex-1">
              {EMOJI_CATEGORIES[selectedCategory as keyof typeof EMOJI_CATEGORIES].map((emoji, index) => (
                <button
                  key={index}
                  type="button"
                  onClick={() => handleEmojiSelect(emoji)}
                  className="w-10 h-10 flex items-center justify-center text-2xl hover:bg-slate-100 rounded-lg transition-colors"
                  title={emoji}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
