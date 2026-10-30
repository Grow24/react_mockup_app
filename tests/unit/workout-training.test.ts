import assert from 'node:assert/strict'
import { crc32 } from 'node:zlib'
import { describe, it } from 'node:test'
import type { Workout, WorkoutSet } from '../../shared/contracts.ts'
import { dataYaml, vocXml, yoloLabel } from '../../server/dataset.ts'
import { zip } from '../../server/zip.ts'
import { classForLabel, suggestBoxes } from '../../src/training/suggest.ts'
import { phaseAt, planSeconds, INTERVAL_PRESETS } from '../../src/workout/intervals.ts'
import { brzycki, epley, estimates, lombardi, percentTable, repsAtPercent } from '../../src/workout/oneRepMax.ts'
import { describeSets, lastSets, recordsFor, workoutVolume } from '../../src/workout/stats.ts'

const near = (actual: number, expected: number, tolerance = 0.01) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not ${expected}`)

describe('one-rep max', () => {
  it('matches the published formulas', () => {
    near(epley(100, 5), 116.667)
    near(brzycki(100, 5), 112.5)
    near(lombardi(100, 5), 117.462)
    assert.equal(estimates(100, 1)!.average, 100)
    assert.equal(estimates(100, 13), null)
    assert.equal(estimates(100, 2.5), null)
    assert.equal(repsAtPercent(85), 5)
    assert.deepEqual(percentTable(140)[3], { percent: 85, weight: 120, reps: 5 })
  })
})

describe('workout records', () => {
  const set = (weightKg: number, reps: number, done = true): WorkoutSet => ({ id: `${weightKg}-${reps}`, weightKg, reps, done })
  const day = (startedAt: number, sets: WorkoutSet[]): Workout => ({
    id: `w${startedAt}`,
    name: 'W',
    startedAt,
    updatedAt: startedAt,
    entries: [{ id: 'e', exerciseId: 'squat', sets }],
  })
  const past = [day(1, [set(100, 5), set(100, 5)]), day(2, [set(105, 3), set(80, 8, false)])]

  it('flags heavier, stronger, and longer sets only', () => {
    assert.deepEqual(recordsFor(set(110, 2), 'squat', past).map((record) => record.kind), ['weight', 'oneRepMax'])
    assert.deepEqual(recordsFor(set(100, 6), 'squat', past).map((record) => record.kind), ['oneRepMax', 'reps'])
    assert.deepEqual(recordsFor(set(90, 5), 'squat', past), [])
    assert.deepEqual(recordsFor(set(60, 5), 'bench', past), [], 'a first try is not a record')
  })

  it('summarises volume and the last sets', () => {
    assert.equal(workoutVolume(past[0]!), 1000)
    assert.equal(describeSets(lastSets(past, 'squat')), '105 kg × 3')
    assert.equal(describeSets(past[0]!.entries[0]!.sets), '2 × 100 kg × 5')
  })
})

describe('interval timer', () => {
  it('walks Tabata phases with no rest after the last round', () => {
    const tabata = INTERVAL_PRESETS[0]!.plan
    assert.equal(planSeconds(tabata), 240)
    assert.deepEqual([0, 10, 30, 40, 239.5, 240].map((t) => phaseAt(tabata, t).kind), ['prepare', 'work', 'rest', 'work', 'work', 'done'])
    assert.equal(phaseAt(tabata, 239.5).round, 8)
  })
})

describe('training data', () => {
  it('maps model labels to training classes', () => {
    const classes = ['ball', 'player', 'racket']
    assert.deepEqual(['sports ball', 'person', 'tennis racket', 'car'].map((label) => classForLabel(label, classes)), [0, 1, 2, -1])
    assert.equal(
      suggestBoxes(
        [
          { label: 'sports ball', score: 0.8, box: { x: 1, y: 2, width: 3, height: 4 } },
          { label: 'person', score: 0.2, box: { x: 0, y: 0, width: 9, height: 9 } },
        ],
        classes,
      ).length,
      1,
    )
  })

  it('writes YOLO labels, data.yaml, and VOC XML', () => {
    assert.equal(yoloLabel([{ classId: 0, x: 300, y: 160, width: 20, height: 20 }], 640, 360), '0 0.484375 0.472222 0.031250 0.055556')
    assert.equal(yoloLabel([{ classId: 1, x: 630, y: 350, width: 40, height: 40 }], 640, 360), '1 0.992188 0.986111 0.015625 0.027778')
    assert.match(dataYaml(["ball", "it's"]), /nc: 2\nnames:\n {2}0: 'ball'\n {2}1: 'it''s'/)
    const xml = vocXml('a.jpg', { width: 640, height: 360, boxes: [{ classId: 0, x: 10, y: 20, width: 30, height: 40 }] }, ['ball <1>'])
    assert.match(xml, /<name>ball &lt;1&gt;<\/name>/)
    assert.match(xml, /<xmin>10<\/xmin><ymin>20<\/ymin><xmax>40<\/xmax><ymax>60<\/ymax>/)
  })

  it('writes a ZIP that reads back byte for byte', () => {
    const entries = [
      { name: 'data.yaml', data: Buffer.from('nc: 1\n') },
      { name: 'images/train/a.jpg', data: Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]) },
    ]
    const archive = zip(entries)
    const count = archive.readUInt16LE(archive.length - 12)
    let offset = archive.readUInt32LE(archive.length - 6)
    assert.equal(count, entries.length)
    for (const entry of entries) {
      assert.equal(archive.readUInt32LE(offset), 0x02014b50)
      const checksum = archive.readUInt32LE(offset + 16)
      const size = archive.readUInt32LE(offset + 20)
      const nameLength = archive.readUInt16LE(offset + 28)
      const local = archive.readUInt32LE(offset + 42)
      assert.equal(archive.subarray(offset + 46, offset + 46 + nameLength).toString(), entry.name)
      const dataStart = local + 30 + archive.readUInt16LE(local + 26)
      const stored = archive.subarray(dataStart, dataStart + size)
      assert.deepEqual(Buffer.from(stored), entry.data)
      assert.equal(checksum, crc32(entry.data) >>> 0)
      offset += 46 + nameLength
    }
  })
})
