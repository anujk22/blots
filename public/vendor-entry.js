export { marked } from 'marked';
export { default as RFB } from '@novnc/novnc';
export { default as hljs } from 'highlight.js/lib/core';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';
import diff from 'highlight.js/lib/languages/diff';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import swift from 'highlight.js/lib/languages/swift';
import shell from 'highlight.js/lib/languages/shell';
for (const [name, language] of Object.entries({ bash, javascript, typescript, python, json, css, xml, sql, diff, yaml, markdown, rust, go, c, cpp, swift, shell })) hljs.registerLanguage(name, language);
// Only the icons the app uses, so the bundle stays small.
export {
  MessageCircle, FolderOpen, Brain, CalendarClock, Activity, SlidersHorizontal, Cpu, Lightbulb, ShieldCheck, Zap, Plus, ArrowRight, ArrowUp, Square,
  Monitor, Maximize2, Minimize2, X, PenLine, Trash2, Search, ChevronDown, Check, Download, Folder, FileText, SquareTerminal, ArrowLeft, Play, Pause,
  PanelLeft, Globe, MousePointer2, Keyboard, Camera, Save, BookOpen, Users, Clock, Hand, CircleStop, RotateCcw, Sparkles, Settings2, Copy, ExternalLink,
} from 'lucide';
