use std::{
    io,
    path::{Path, PathBuf},
};

pub fn admit_root(root: &Path) -> io::Result<PathBuf> {
    use std::fs;
    let temporary = fs::canonicalize(std::env::temp_dir())?;
    let metadata = fs::symlink_metadata(root)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(io::Error::other("Fixture root must not be a reparse point"));
        }
    }
    let canonical = fs::canonicalize(root)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || canonical.parent() != Some(temporary.as_path())
        || !canonical
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("lumen-native-performance-"))
        || fs::read_dir(&canonical)?.next().is_some()
    {
        return Err(io::Error::other(
            "Fixture requires a fresh owned lumen-native-performance- child of Windows temp",
        ));
    }
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(canonical.join("fixture-owner"))?;
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn fresh_owned_root_is_admitted_once_without_touching_other_data() {
        let root = std::env::temp_dir().join(format!(
            "lumen-native-performance-root-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let result = admit_root(&root);
        assert!(result.is_ok(), "{result:?}");
        assert!(admit_root(&root).is_err());
        assert!(root.join("fixture-owner").is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn temp_root_and_existing_content_are_refused() {
        assert!(admit_root(&std::env::temp_dir()).is_err());
        let root = std::env::temp_dir().join(format!(
            "lumen-native-performance-nonempty-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("keep"), "untouched").unwrap();
        assert!(admit_root(&root).is_err());
        assert_eq!(fs::read_to_string(root.join("keep")).unwrap(), "untouched");
        assert!(!root.join("fixture-owner").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn nested_root_wrong_name_and_file_are_refused() {
        let root = std::env::temp_dir().join(format!(
            "lumen-native-performance-boundary-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let nested = root.join("lumen-native-performance-nested");
        fs::create_dir(&nested).unwrap();
        assert!(admit_root(&nested).is_err());
        let file = root.join("lumen-native-performance-file");
        fs::write(&file, "untouched").unwrap();
        assert!(admit_root(&file).is_err());
        assert!(admit_root(Path::new(".")).is_err());
        assert!(!nested.join("fixture-owner").exists());
        assert_eq!(fs::read_to_string(file).unwrap(), "untouched");
        assert_eq!(
            fs::canonicalize(&root).unwrap().parent(),
            Some(fs::canonicalize(std::env::temp_dir()).unwrap().as_path())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn symlink_root_is_refused_without_touching_its_target() {
        let root = std::env::temp_dir().join(format!(
            "lumen-native-performance-link-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let target = root.with_extension("target");
        fs::create_dir(&target).unwrap();
        std::os::windows::fs::symlink_dir(&target, &root).unwrap();
        assert!(admit_root(&root).is_err());
        assert!(fs::read_dir(&target).unwrap().next().is_none());
        fs::remove_dir(root).unwrap();
        fs::remove_dir(target).unwrap();
    }
}
