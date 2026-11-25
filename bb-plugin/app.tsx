import { definePluginApp, type PluginPendingInteractionProps } from '@get-bb/plugin-sdk/app';
import { useState } from 'react';

type ReviewPayload = {
  audio: string | null;
  name: string;
  suggestionId: string | null;
  tentative: boolean;
  choices: {id: string; name: string; crossProject?: boolean}[];
};

function ReviewForm({interaction, submit, cancel}: PluginPendingInteractionProps) {
  const data = interaction.payload as ReviewPayload;
  const [id, setId] = useState('');
  const [name, setName] = useState(data.name);
  const [save, setSave] = useState(false);
  const [consent, setConsent] = useState(false);
  const [across, setAcross] = useState(false);
  const [transfer, setTransfer] = useState(false);
  const [failedAudio, setFailedAudio] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const person = data.choices.find(choice => choice.id === id);
  const suggestion = data.choices.find(choice => choice.id === data.suggestionId);
  const invalid = (!id && !name.trim()) || (save && !consent) || (person?.crossProject && !transfer) || submitted;

  return <form className="space-y-3 p-3" onSubmit={async event => {
    event.preventDefault();
    if (invalid) return;
    setSubmitted(true);
    try {
      await submit({
        ...(id ? {profileId:id} : {name:name.trim()}),
        saveVoice:save,
        consent:save && consent,
        allowAcrossProjects:!id && save && across,
        transferConsent:!!person?.crossProject && transfer,
      });
    } catch {
      setSubmitted(false);
    }
  }}>
    <div className="text-sm font-semibold">{interaction.title}</div>
    {data.audio && <audio className="max-w-full" controls preload="none" src={data.audio} onError={() => setFailedAudio(true)} />}
    {failedAudio && <p role="status">Отрывок недоступен. Можно закрыть форму и открыть её снова.</p>}
    {suggestion && <p className="text-sm">
      {suggestion.crossProject ? 'Возможный голос из другого проекта' : 'Возможное совпадение'} · {suggestion.name}?
    </p>}
    <label className="block">
      Профиль
      <select value={id} className="block w-full rounded border bg-background p-2"
        onChange={event => {setId(event.target.value); setTransfer(false);}}>
        <option value="">Ввести имя</option>
        {data.choices.map(choice => <option key={choice.id} value={choice.id}>
          {choice.name}{choice.crossProject ? ' · другой проект' : ''}
        </option>)}
      </select>
    </label>
    {!id && <label className="block">
      Имя говорящего
      <input value={name} className="block w-full rounded border bg-background p-2"
        onChange={event => setName(event.target.value)} required maxLength={96} />
    </label>}
    {person?.crossProject && <label className="block">
      <input type="checkbox" checked={transfer} onChange={event => setTransfer(event.target.checked)} />{' '}
      Это тот же человек. Добавить профиль в этот проект
    </label>}
    {data.audio && <label className="block">
      <input type="checkbox" checked={save} onChange={event => setSave(event.target.checked)} />{' '}
      Сохранить голосовой отпечаток для будущих встреч
    </label>}
    {save && <>
      <label className="block"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />{' '}
        Участник согласился на сохранение отпечатка
      </label>
      {!id && <label className="block"><input type="checkbox" checked={across} onChange={event => setAcross(event.target.checked)} />{' '}
        Разрешить поиск этого голоса в других проектах пилота
      </label>}
    </>}
    <div className="flex gap-2">
      <button className="rounded border px-3 py-1" type="button" onClick={() => void cancel()}>Пропустить</button>
      <button className="rounded border px-3 py-1 disabled:opacity-50" type="submit" disabled={invalid}>Подтвердить</button>
    </div>
  </form>;
}

function ForgetForm({interaction, submit, cancel}: PluginPendingInteractionProps) {
  const {name} = interaction.payload as {name:string};
  return <div className="space-y-3 p-3">
    <p>Удалить отпечатки «{name}» и активные привязки во всех проектах? Уже выданные файлы сохранятся.</p>
    <div className="flex gap-2">
      <button className="rounded border px-3 py-1" onClick={() => void cancel()}>Отмена</button>
      <button className="rounded border px-3 py-1" onClick={() => void submit(true)}>Удалить профиль</button>
    </div>
  </div>;
}

export default definePluginApp(app => {
  app.slots.pendingInteraction({id:'voice-review', component:ReviewForm});
  app.slots.pendingInteraction({id:'voice-forget', component:ForgetForm});
});
