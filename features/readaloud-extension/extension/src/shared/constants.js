export const DB_NAME = "readaloud_mvp";
export const DB_VERSION = 2;
// Downloaded audio stays until the user deletes it from the library; the TTL
// is only a safety net against unbounded growth from abandoned chapters.
export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_CHARS = 600;
export const MAX_CHUNK_CHARS = 1000;
export const STREAM_LOOKAHEAD_DEPTH = 2;
export const STREAM_READY_BUFFER_MS = 750;
export const MIN_READY_CHUNKS = 2;
export const STARTUP_READY_CHUNKS = 3;
export const TARGET_READY_CHUNKS = 5;
export const MAX_READY_CHUNKS = 8;
export const DEFAULT_STORY_ID = "hardcoded-story";
export const DEFAULT_CHAPTER_ID = "hardcoded-chapter-1";
export const DEFAULT_VOICE = "af_heart";
export const DEFAULT_PROVIDER_MODE = "local";
export const HARD_CODED_TEXT = `The rain had just stopped when the train crossed the final bridge into town.

Mina leaned against the window and watched the river carry bright scraps of evening light downstream.
She had promised herself that this return would be practical, short, and uneventful. But the station platform looked exactly as it had in childhood, and memory ignored every schedule she had written for herself.

Inside the old family bookstore, dust and cedar still shared the same air.
The bell above the door rang with a thin metallic note, and the shelves answered in silence.
Boxes of unsorted donations waited near the back room. A kettle sat cold beside the register. Everything suggested interruption rather than closure.

She opened the first box and found a stack of handwritten pages tied with blue thread.
The top sheet began in her father's careful print: "Read this aloud when the shop is empty."
Mina laughed once under her breath, partly from disbelief and partly because the shop was, in fact, empty.

By the time she reached the third page, she understood that the manuscript was unfinished on purpose.
There were missing names, blank dialogue lines, and a note in the margin asking whoever found it to decide how the story should continue.
Outside, the last commuters passed the window without looking in. Inside, the silence felt less abandoned than expectant.

So she pulled a stool into the aisle, set the pages on her lap, and started reading from the beginning, this time slowly enough to hear how the sentences wanted to sound.`;
