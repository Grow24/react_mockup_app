const COLORS = ['#f3d38a', '#7fd8cf', '#e0603c', '#a98bf0', '#9ee86b', '#f08bc8', '#6bb7f0', '#f0b46b', '#cfcfcf']

export function classColor(classId: number) {
  return COLORS[classId % COLORS.length]!
}
