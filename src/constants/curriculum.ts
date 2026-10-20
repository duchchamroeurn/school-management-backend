// Default MoEYS secondary curriculum: which subjects each grade takes.
// Used by the seed (first install) and when a school-level change adds grades.
const LOWER = [7, 8, 9];
const ALL = [7, 8, 9, 10, 11, 12];

export const DEFAULT_SUBJECTS = [
  { code: 'KHMER', khmerName: 'អក្សរសាស្ត្រខ្មែរ', latinName: 'Khmer Literature', isCoreSubject: true, grades: ALL },
  { code: 'MATH', khmerName: 'គណិតវិទ្យា', latinName: 'Mathematics', isCoreSubject: true, grades: ALL },
  { code: 'PHYSICS', khmerName: 'រូបវិទ្យា', latinName: 'Physics', isCoreSubject: true, grades: ALL },
  { code: 'CHEMISTRY', khmerName: 'គីមីវិទ្យា', latinName: 'Chemistry', isCoreSubject: true, grades: ALL },
  { code: 'BIOLOGY', khmerName: 'ជីវវិទ្យា', latinName: 'Biology', isCoreSubject: true, grades: ALL },
  { code: 'EARTH_SCIENCE', khmerName: 'ផែនដីវិទ្យា', latinName: 'Earth Science', isCoreSubject: true, grades: ALL },
  { code: 'HISTORY', khmerName: 'ប្រវត្តិវិទ្យា', latinName: 'History', isCoreSubject: true, grades: ALL },
  { code: 'GEOGRAPHY', khmerName: 'ភូមិវិទ្យា', latinName: 'Geography', isCoreSubject: true, grades: ALL },
  { code: 'MORALITY_CIVICS', khmerName: 'សីលធម៌-ពលរដ្ឋវិជ្ជា', latinName: 'Morality-Civics', isCoreSubject: true, grades: ALL },
  { code: 'ENGLISH', khmerName: 'ភាសាអង់គ្លេស', latinName: 'English', isCoreSubject: true, grades: ALL },
  { code: 'HOME_ECONOMICS', khmerName: 'គេហវិទ្យា', latinName: 'Home Economics', isCoreSubject: false, grades: LOWER },
  { code: 'PE', khmerName: 'អប់រំកាយ និងកីឡា', latinName: 'Physical Education & Sport', isCoreSubject: false, grades: ALL },
  { code: 'ICT', khmerName: 'បច្ចេកវិទ្យាព័ត៌មាន', latinName: 'ICT', isCoreSubject: false, grades: ALL },
];
