// Calendar dates (attendance days, period start/end, deadlines) are stored as UTC midnight and compared as
// YYYY-MM-DD strings. "Today" is the school's local date, not the server's UTC date.
const SCHOOL_TIME_ZONE = 'Asia/Phnom_Penh';

export const isoDate = (date: Date) => date.toISOString().slice(0, 10);

export const todayAtSchool = () => new Intl.DateTimeFormat('en-CA', { timeZone: SCHOOL_TIME_ZONE }).format(new Date()); // YYYY-MM-DD
