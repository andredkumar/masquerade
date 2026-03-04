import { Scissors, Tag, Search, PenLine, Download } from "lucide-react";

interface TaskSelectorProps {
  selectedTask: string;
  onTaskChange: (task: string) => void;
}

const TASKS = [
  { id: 'segment', label: 'Segment', icon: Scissors, tooltip: 'Draw a mask around a structure' },
  { id: 'classify', label: 'Classify', icon: Tag, tooltip: 'Identify the ultrasound view' },
  { id: 'detect', label: 'Detect', icon: Search, tooltip: 'Find and locate structures' },
  { id: 'label', label: 'Label', icon: PenLine, tooltip: 'Annotate structures with names' },
  { id: 'export', label: 'Export', icon: Download, tooltip: 'Export labeled data as a dataset' },
] as const;

export default function TaskSelector({ selectedTask, onTaskChange }: TaskSelectorProps) {
  return (
    <div className="px-4 py-3">
      <div className="grid grid-cols-2 gap-2">
        {TASKS.map(({ id, label, icon: Icon, tooltip }) => (
          <button
            key={id}
            onClick={() => onTaskChange(id)}
            title={tooltip}
            className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
              selectedTask === id
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
