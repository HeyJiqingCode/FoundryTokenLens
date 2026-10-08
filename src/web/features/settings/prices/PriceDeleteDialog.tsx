import { LocalizedLabel } from '../../../components/LocalizedLabel';
import { api } from '../../../api';
import { t, useLocale } from '../../../i18n';
import { TypedDeleteDialog } from '../../../components/ConfirmDialog';
import { modelTitle, type ModelPrices } from './model-prices';

export function PriceDeleteDialog({
  model,
  onClose,
  onDeleted,
}: {
  model: ModelPrices;
  onClose: () => void;
  onDeleted: () => void;
}) {
  useLocale();
  return (
    <TypedDeleteDialog
      title={t('pricing.deleteModel')}
      subtitle={`${model.displayName || modelTitle(model.name)} · ${model.name}`}
      copy={{ label: t('pricing.copyModelId'), copied: 'pricing.modelIdCopied' }}
      message={<LocalizedLabel message="pricing.deleteModelNotice" />}
      confirmation={{
        label: <LocalizedLabel message="pricing.confirmModelId" />,
        expected: model.name,
        name: 'deleteModelConfirmation',
        maxLength: 160,
        placeholder: model.name,
      }}
      confirmLabel={<LocalizedLabel message="pricing.confirmModelDeletion" />}
      onConfirm={async (confirmation) => {
        await api('/api/pricing/models', {
          method: 'DELETE',
          body: { model: model.name, confirmation },
        });
        onDeleted();
      }}
      onClose={onClose}
    />
  );
}
