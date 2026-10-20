/**
 * The dialog that names a list: a new one, or a rename.
 *
 * The name is the person's own words and goes to the server as typed (trimmed);
 * the server owns the rules — non-empty, at most `MAX_SAVED_LIST_NAME_LENGTH`
 * characters, distinct from their other lists ignoring case — and a refusal
 * comes back as a sentence under the field.
 */
import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import { Text } from '@oxy.so/bloom/typography';
import { MAX_SAVED_LIST_NAME_LENGTH } from '@goway.to/sdk';

import { useTranslation } from '@/lib/i18n';

import { savedFailureMessage } from './savedErrors';

export interface ListNameDialogProps {
  title: string;
  /** The label of the confirming button. */
  confirmLabel: string;
  /** The name to start from (a rename). */
  initialName?: string;
  /** Save the name; reject to keep the dialog open with the reason. */
  onSubmit: (name: string) => Promise<unknown>;
  onClose: () => void;
}

export function ListNameDialog({
  title,
  confirmLabel,
  initialName = '',
  onSubmit,
  onClose,
}: ListNameDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const trimmed = name.trim();
    if (trimmed === '' || working) return;
    setWorking(true);
    setFailure(null);
    try {
      await onSubmit(trimmed);
      onClose();
    } catch (error) {
      setFailure(savedFailureMessage(error, t));
      setWorking(false);
    }
  }, [name, onClose, onSubmit, t, working]);

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      placement={{ base: 'bottom', md: 'center' }}
      testID="list-name-dialog"
    >
      <View className="gap-space-12">
        <TextField>
          <TextFieldInput
            label={t('saved.list.nameLabel')}
            placeholder={t('saved.list.namePlaceholder')}
            value={name}
            onChangeText={setName}
            maxLength={MAX_SAVED_LIST_NAME_LENGTH}
            onSubmitEditing={() => void submit()}
            returnKeyType="done"
            autoFocus
            disabled={working}
          />
        </TextField>
        {failure ? (
          <Text className="text-bodySmall text-destructive" accessibilityRole="alert">
            {failure}
          </Text>
        ) : null}
        <View className="flex-row justify-end gap-space-8">
          <Button
            size="sm"
            tone="neutral"
            appearance="outline"
            onPress={onClose}
            disabled={working}
          >
            {t('saved.list.cancel')}
          </Button>
          <Button
            size="sm"
            tone="accent"
            appearance="solid"
            disabled={name.trim() === '' || working}
            onPress={() => void submit()}
          >
            {confirmLabel}
          </Button>
        </View>
      </View>
    </Dialog>
  );
}
