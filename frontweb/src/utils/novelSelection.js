export function novelSelectionForm(file, title, rows, creation) {
  const episodes = rows.map(({ chapter, targetNumber, target }) => {
    let expected = null
    if (target) {
      expected = { id: target.id, title: target.title, updated_at: target.updated_at }
      if (target.script_content === chapter.source.text) expected.script_is_source = true
      else expected.script_content = target.script_content
    }
    return { index: chapter.index, episode_number: targetNumber, parts: chapter.source.parts, expected }
  })
  const form = new FormData()
  form.append('file', file, 'novel.txt')
  form.append('selection', new Blob([JSON.stringify({ ...creation, title, episodes })], { type: 'application/json' }), 'selection.json')
  return form
}
